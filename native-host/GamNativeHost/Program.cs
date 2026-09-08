using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

const int MaxMessageBytes = 1024 * 1024;
var allowedMethods = new HashSet<string>(StringComparer.Ordinal)
{
    "health", "control.snapshot", "browser.report", "browser.status", "agent.browser-report", "agent.runtime-report", "agent.rollover-request", "agent.rollover-begin", "agent.rollover-bootstrap", "agent.rollover-complete", "agent.rollover-fail", "agent.rollover-status", "browser.operation-plan", "browser.operation-dispatch", "browser.operation-settle", "incident.report", "project.list", "agent.list", "resource.list", "lease.list", "events.list", "work.snapshot", "work.replace", "work.mutate", "fleet.reconcile", "workspace.provision", "workspace.list"
};

try
{
    var config = HostConfig.Load(AppContext.BaseDirectory);
    var origin = args.FirstOrDefault(arg => arg.StartsWith("chrome-extension://", StringComparison.Ordinal));
    if (!string.Equals(origin, config.AllowedOrigin, StringComparison.Ordinal))
        throw new InvalidOperationException("Native host caller origin is not allowed.");

    var browserToken = File.ReadAllText(config.BrowserTokenPath, Encoding.UTF8).Trim();
    if (browserToken.Length < 32) throw new InvalidOperationException("Browser token is missing or invalid.");
    using var forwarder = new PipeForwarder(config.PipeName);
    using var input = Console.OpenStandardInput();
    using var output = Console.OpenStandardOutput();
    while (TryReadFrame(input, out var payload))
    {
        var response = Handle(payload, config, browserToken, allowedMethods, forwarder);
        WriteFrame(output, response);
    }
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    Environment.ExitCode = 1;
}

static bool TryReadFrame(Stream input, out byte[] payload)
{
    payload = Array.Empty<byte>();
    Span<byte> header = stackalloc byte[4];
    var first = input.ReadByte();
    if (first < 0) return false;
    header[0] = (byte)first;
    ReadExactly(input, header[1..]);
    var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
    if (length == 0 || length > MaxMessageBytes) throw new InvalidDataException("Native message size is invalid.");
    payload = new byte[length];
    ReadExactly(input, payload);
    return true;
}

static void ReadExactly(Stream stream, Span<byte> buffer)
{
    var offset = 0;
    while (offset < buffer.Length)
    {
        var read = stream.Read(buffer[offset..]);
        if (read == 0) throw new EndOfStreamException("Unexpected end of native message.");
        offset += read;
    }
}

static void WriteFrame(Stream output, byte[] payload)
{
    if (payload.Length > MaxMessageBytes) throw new InvalidDataException("Native response is too large.");
    Span<byte> header = stackalloc byte[4];
    BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)payload.Length);
    output.Write(header);
    output.Write(payload);
    output.Flush();
}

static byte[] Handle(
    byte[] payload,
    HostConfig config,
    string browserToken,
    HashSet<string> allowedMethods,
    PipeForwarder forwarder)
{
    string id = "unknown";
    try
    {
        var request = JsonNode.Parse(payload) as JsonObject ?? throw new InvalidDataException("Native request must be a JSON object.");
        id = request["id"]?.GetValue<string>() ?? throw new InvalidDataException("Request id is required.");
        var method = request["method"]?.GetValue<string>() ?? throw new InvalidDataException("Request method is required.");
        if (!allowedMethods.Contains(method)) return Error(id, "FORBIDDEN", $"Native host does not allow method {method}.");

        var forwarded = new JsonObject
        {
            ["id"] = id,
            ["method"] = method,
            ["instanceId"] = config.InstanceId,
            ["auth"] = new JsonObject { ["browserToken"] = browserToken },
        };
        if (request["params"] is JsonObject parameters) forwarded["params"] = parameters.DeepClone();
        return forwarder.Forward(Encoding.UTF8.GetBytes(forwarded.ToJsonString()));
    }
    catch (Exception error)
    {
        return Error(id, "INVALID_REQUEST", error.Message);
    }
}

static byte[] Error(string id, string code, string message)
{
    var value = new JsonObject
    {
        ["id"] = id,
        ["ok"] = false,
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };
    return Encoding.UTF8.GetBytes(value.ToJsonString());
}

sealed class PipeForwarder : IDisposable
{
    private readonly string pipeName;
    private NamedPipeClientStream? pipe;
    private StreamWriter? writer;
    private StreamReader? reader;

    public PipeForwarder(string configuredPipeName)
    {
        pipeName = configuredPipeName.StartsWith("\\\\.\\pipe\\", StringComparison.OrdinalIgnoreCase)
            ? configuredPipeName[9..]
            : configuredPipeName;
    }

    public byte[] Forward(byte[] request)
    {
        Exception? failure = null;
        for (var attempt = 0; attempt < 2; attempt += 1)
        {
            try
            {
                EnsureConnected();
                writer!.WriteLine(Encoding.UTF8.GetString(request));
                var response = reader!.ReadLine() ?? throw new IOException("gamd closed the pipe without a response.");
                var payload = Encoding.UTF8.GetBytes(response);
                if (payload.Length > MaxMessageBytes) throw new InvalidDataException("gamd response is too large.");
                return payload;
            }
            catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException or ObjectDisposedException)
            {
                failure = error;
                Reset();
            }
        }
        throw failure ?? new IOException("Unable to forward native request to gamd.");
    }

    private void EnsureConnected()
    {
        if (pipe?.IsConnected == true && writer is not null && reader is not null) return;
        Reset();
        pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None);
        pipe.Connect(3000);
        writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
        reader = new StreamReader(pipe, new UTF8Encoding(false), false, leaveOpen: true);
    }

    private void Reset()
    {
        try { writer?.Dispose(); } catch { }
        try { reader?.Dispose(); } catch { }
        try { pipe?.Dispose(); } catch { }
        writer = null;
        reader = null;
        pipe = null;
    }

    public void Dispose() => Reset();
}

sealed record HostConfig(string PipeName, string BrowserTokenPath, string AllowedOrigin, string InstanceId)
{
    public static HostConfig Load(string baseDirectory)
    {
        var path = Path.Combine(baseDirectory, "gam-native-host.json");
        if (!File.Exists(path)) throw new FileNotFoundException("Native host config is missing.", path);
        using var document = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
        var root = document.RootElement;
        var pipeName = Required(root, "pipeName");
        var tokenPath = Required(root, "browserTokenPath");
        var origin = Required(root, "allowedOrigin");
        var instanceId = Required(root, "instanceId");
        if (!origin.StartsWith("chrome-extension://", StringComparison.Ordinal) || !origin.EndsWith('/'))
            throw new InvalidDataException("allowedOrigin is invalid.");
        if (!Regex.IsMatch(instanceId, "^[0-9a-f]{16}$", RegexOptions.CultureInvariant))
            throw new InvalidDataException("instanceId is invalid.");
        return new HostConfig(pipeName, Path.GetFullPath(tokenPath), origin, instanceId);
    }

    private static string Required(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            throw new InvalidDataException($"{name} is required.");
        var text = value.GetString()?.Trim();
        return string.IsNullOrEmpty(text) ? throw new InvalidDataException($"{name} is required.") : text;
    }
}
