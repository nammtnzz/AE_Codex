// Built once by Initialize-AeLibrary.ps1 as a Windows subsystem executable.
// Setup/logon starts --serve. AE only writes a fixed JSON request pointer.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class AeBackgroundLauncher
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 20 };
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly Regex IdPattern = new Regex("^[A-Za-z0-9-]{8,80}$", RegexOptions.CultureInvariant);
    private static string workspace;
    private static string library;
    private static string chat;
    private static string launcherSha256;
    private static string sourceSha256;

    private sealed class Worker
    {
        internal Process Process;
        internal string Id;
        internal string Session;
        internal string StatusPath;
        internal bool Started;
        internal bool OutputDrainStarted;
        internal bool ErrorDrainStarted;
        internal bool Completed;
        internal readonly StringBuilder Errors = new StringBuilder();
    }

    private sealed class ChatWorker
    {
        internal Process Process;
        internal bool StopRequested;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            // Arguments and request bodies cannot select a program or script.
            bool serve = args.Length == 1 && args[0] == "--serve";
            if (args.Length != 0 && !serve) return 2;
            string tools = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            workspace = Path.GetFullPath(Path.Combine(tools, ".."));
            library = Path.Combine(workspace, ".ae-codex", "library");
            chat = Path.Combine(workspace, ".ae-codex", "chat");
            if (serve) return Serve(tools);
            Worker worker = DispatchPending(tools);
            if (worker != null) Complete(worker);
            return 0;
        }
        catch (Exception ex)
        {
            Log("Launcher: " + ex.Message);
            return 1;
        }
    }

    private static Worker DispatchPending(string tools)
    {
            string requests = Path.Combine(library, "requests");
            AssertOrdinaryPath(requests);
            if (!Directory.Exists(requests)) return null;
            string pointerPath = Path.Combine(requests, "pending-launch.json");
            if (!File.Exists(pointerPath)) return null;
            Dictionary<string, object> pointer = ReadJson(pointerPath);
            string id = Text(pointer, "requestId");
            string session = Text(pointer, "sessionId");
            if (Integer(pointer, "schemaVersion") != 1 || !IdPattern.IsMatch(id) || !IdPattern.IsMatch(session))
                throw new InvalidDataException("The pending SFX launch pointer has an invalid identity.");
            // Only the most recent explicitly submitted immutable request is
            // eligible. Old files and stopped sessions are never rediscovered.
            return Dispatch(Path.Combine(requests, "sfx-" + id + ".json"), id, session, tools);
    }

    private static int Serve(string tools)
    {
        AssertOrdinaryPath(library);
        Directory.CreateDirectory(library);
        string lockPath = Path.Combine(library, "background-service.lock");
        AssertOrdinaryPath(lockPath);
        FileStream lease;
        try { lease = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { return 0; } // One resident per workspace/user.
        using (lease)
        {
            string executable = Assembly.GetExecutingAssembly().Location;
            DateTime executableWritten = File.GetLastWriteTimeUtc(executable);
            long executableBytes = new FileInfo(executable).Length;
            launcherSha256 = HashFile(executable);
            Dictionary<string, object> certificate = ReadJson(Path.Combine(library, "background-launcher.json"));
            sourceSha256 = Text(certificate, "sourceSha256");
            if (Text(certificate, "launcherSha256") != launcherSha256 || !RuntimeMatches(executable))
                throw new InvalidDataException("Background runtime identity is not current. Repair Codex AE from its installer.");
            string requests = Path.Combine(library, "requests");
            AssertOrdinaryPath(requests);
            Directory.CreateDirectory(requests);
            string stopPath = Path.Combine(library, "background-service.stop");
            AssertOrdinaryPath(stopPath);
            // A new activated resident consumes the previous shutdown marker.
            if (File.Exists(stopPath)) File.Delete(stopPath);
            DateTime earliestPointer = DateTime.UtcNow.AddSeconds(-10);
            string pointerPath = Path.Combine(requests, "pending-launch.json");
            DateTime lastPointer = DateTime.MinValue;
            long lastPointerLength = -1;
            DateTime nextHeartbeat = DateTime.MinValue;
            Worker active = null;
            ChatWorker activeChat = FindOwnedChat();
            // Legacy hosts may drain during an upgrade; this resident never starts a chat.
            if (activeChat != null) RequestChatStop(activeChat);
            bool stopping = false;
            WriteServiceState("ready");
            nextHeartbeat = DateTime.UtcNow.AddSeconds(5);
            using (FileSystemWatcher watcher = new FileSystemWatcher(requests, "pending-launch.json"))
            {
                watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size;
                watcher.EnableRaisingEvents = true;
                try
                {
                    while (true)
                    {
                        if (!Directory.Exists(workspace) || !File.Exists(executable) || !RuntimeMatches(executable) || File.Exists(stopPath)) stopping = true;
                        if (!stopping && (File.GetLastWriteTimeUtc(executable) != executableWritten || new FileInfo(executable).Length != executableBytes))
                        {
                            if (HashFile(executable) != launcherSha256) stopping = true;
                            executableWritten = File.GetLastWriteTimeUtc(executable);
                            executableBytes = new FileInfo(executable).Length;
                        }
                        if (active != null && active.Process.HasExited) { Complete(active); active = null; }
                        if (activeChat != null && activeChat.Process.HasExited) { CompleteChat(activeChat); activeChat = null; }
                        if (stopping && activeChat != null) RequestChatStop(activeChat);
                        if (stopping && active == null && activeChat == null) break;
                        if (DateTime.UtcNow >= nextHeartbeat)
                        {
                            WriteServiceState(stopping ? "stopping" : "ready");
                            nextHeartbeat = DateTime.UtcNow.AddSeconds(5);
                        }
                        if (!stopping && active == null && File.Exists(pointerPath))
                        {
                            try
                            {
                                // Stop may remove the pointer, and publication
                                // atomically replaces it. Metadata and contents
                                // can disappear after File.Exists succeeds.
                                FileInfo pointer = new FileInfo(pointerPath);
                                DateTime written = pointer.LastWriteTimeUtc;
                                long length = pointer.Length;
                                if (written != lastPointer || length != lastPointerLength)
                                {
                                    // A logon must not revive an abandoned request
                                    // left by an earlier AE/Windows session.
                                    if (written >= earliestPointer || LiveBridgeOwnsPointer(pointerPath, written))
                                    {
                                        lastPointer = written;
                                        lastPointerLength = length;
                                        active = DispatchPending(tools);
                                    }
                                    else if ((DateTime.UtcNow - written).TotalMilliseconds > 60000)
                                    {
                                        lastPointer = written;
                                        lastPointerLength = length;
                                    }
                                    // A delayed logon resident may start before
                                    // AE publishes its next heartbeat. A recent
                                    // older pointer is rechecked until age 60s.
                                }
                            }
                            catch (FileNotFoundException) { }
                            catch (DirectoryNotFoundException) { }
                            catch (IOException ex) { Log("Pending request changed: " + ex.Message); }
                            catch (Exception ex) { Log("Pending request: " + ex.Message); }
                        }
                        watcher.WaitForChanged(WatcherChangeTypes.All, 1000);
                    }
                }
                finally
                {
                    // Shutdown never terminates an already launched scanner.
                    if (active != null) Complete(active);
                    if (activeChat != null)
                    {
                        // The installer must keep waiting/return a retryable
                        // error while the child drains. Never kill AE or detach
                        // a chat that may still be calling an installed tool.
                        while (!activeChat.Process.HasExited)
                        {
                            RequestChatStop(activeChat);
                            activeChat.Process.WaitForExit(1000);
                        }
                        CompleteChat(activeChat);
                    }
                    if (Directory.Exists(library)) WriteServiceState("stopped");
                }
            }
        }
        return 0;
    }

    private static bool RuntimeMatches(string executable)
    {
        try
        {
            Dictionary<string, object> runtime = ReadJson(Path.Combine(library, "runtime.json"));
            return Text(runtime, "backgroundLauncherPath").Equals(executable, StringComparison.OrdinalIgnoreCase) &&
                Text(runtime, "backgroundLauncherSha256") == launcherSha256 && Integer(runtime, "backgroundServiceVersion") == 1;
        }
        catch { return false; }
    }

    private static long EpochMilliseconds(DateTime value)
    {
        return (long)(value.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    private static long LongInteger(Dictionary<string, object> value, string key)
    {
        object found;
        if (value == null || !value.TryGetValue(key, out found) || !(found is int || found is long))
            throw new InvalidDataException("Missing integer launcher metadata.");
        return Convert.ToInt64(found);
    }

    private static bool SameWorkspace(string value)
    {
        return Path.IsPathRooted(value) && Path.GetFullPath(value).TrimEnd('\\', '/').Equals(workspace.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
    }

    private static ChatWorker FindOwnedChat()
    {
        // This also adopts an owned child left alive if the resident itself
        // crashed. Exact process creation time closes the PID-reuse gap.
        foreach (string name in new string[] { "launch.json", "host.json" })
        {
            try
            {
                string path = Path.Combine(chat, name);
                if (!File.Exists(path)) continue;
                Dictionary<string, object> identity = ReadJson(path);
                string expectedSchema = name == "launch.json" ? "codex-ae-chat-launch/v1" : "codex-ae-chat-host/v1";
                if (Text(identity, "schema") != expectedSchema || !SameWorkspace(Text(identity, "workspaceRoot"))) continue;
                int pid = checked((int)LongInteger(identity, "pid"));
                long created = LongInteger(identity, "processStartEpochMs");
                object recordedNode;
                string node = identity.TryGetValue("nodePath", out recordedNode) && recordedNode is string ? (string)recordedNode : "";
                if (String.IsNullOrEmpty(node))
                {
                    Dictionary<string, object> runtime = ReadJson(Path.Combine(library, "runtime.json"));
                    node = Text(runtime, "nodePath");
                }
                if (!Path.IsPathRooted(node) || !Path.GetFileName(node).Equals("node.exe", StringComparison.OrdinalIgnoreCase)) continue;
                AssertOrdinaryPath(node);
                Process process = Process.GetProcessById(pid);
                try
                {
                    long kernelCreated = EpochMilliseconds(process.StartTime);
                    // host.json records JS startup after kernel creation;
                    // launch.json records the exact kernel creation time.
                    bool creationMatches = name == "launch.json" ? Math.Abs(kernelCreated - created) <= 20 :
                        created >= kernelCreated && created - kernelCreated <= 60000 &&
                        EpochMilliseconds(DateTime.UtcNow) - LongInteger(identity, "timestampEpochMs") >= 0 &&
                        EpochMilliseconds(DateTime.UtcNow) - LongInteger(identity, "timestampEpochMs") <= 15000;
                    if (!process.HasExited && creationMatches &&
                        Path.GetFullPath(process.MainModule.FileName).Equals(Path.GetFullPath(node), StringComparison.OrdinalIgnoreCase))
                        return new ChatWorker { Process = process };
                }
                catch { process.Dispose(); throw; }
                process.Dispose();
            }
            catch { }
        }
        return null;
    }

    private static void RequestChatStop(ChatWorker worker)
    {
        if (worker.StopRequested) return;
        try
        {
            ReplaceJson(Path.Combine(chat, "stop"), new Dictionary<string, object> {
                {"schema", "codex-ae-chat-stop/v1"}, {"service", true}, {"createdAtEpochMs", EpochMilliseconds(DateTime.UtcNow)}
            });
            worker.StopRequested = true;
        }
        catch { Log("Chat stop marker could not be published. The owned host remains attached; shutdown will retry."); }
    }

    private static void CompleteChat(ChatWorker worker)
    {
        // Adopted legacy processes have no redirected readers. Do not execute,
        // restart, or claim a terminal conversation result during cleanup.
        worker.Process.Dispose();
    }

    private static void ReplaceJson(string path, object value)
    {
        AssertOrdinaryPath(path);
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, Json.Serialize(value), Utf8);
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    if (File.Exists(path)) File.Replace(temporary, path, null);
                    else File.Move(temporary, path);
                    break;
                }
                catch (IOException) { if (attempt >= 4) throw; Thread.Sleep(20); }
            }
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static bool LiveBridgeOwnsPointer(string pointerPath, DateTime written)
    {
        try
        {
            double pointerAge = (DateTime.UtcNow - written).TotalMilliseconds;
            if (pointerAge < 0 || pointerAge > 60000) return false;
            Dictionary<string, object> pointer = ReadJson(pointerPath);
            Dictionary<string, object> heartbeat = ReadJson(Path.Combine(workspace, ".ae-codex", "bridge", "heartbeat.json"));
            if (Text(heartbeat, "schema") != "codex-ae-heartbeat/v1" ||
                (Text(heartbeat, "state") != "running" && Text(heartbeat, "state") != "starting") ||
                Text(heartbeat, "sessionNonce") != Text(pointer, "sessionId")) return false;
            object rawLibrary;
            if (!heartbeat.TryGetValue("library", out rawLibrary)) return false;
            Dictionary<string, object> inventory = rawLibrary as Dictionary<string, object>;
            if (inventory == null || Text(inventory, "requestId") != Text(pointer, "requestId") || Text(inventory, "state") != "scanning") return false;
            object rawTimestamp;
            if (!heartbeat.TryGetValue("timestampEpochMs", out rawTimestamp) || !(rawTimestamp is long || rawTimestamp is int)) return false;
            double now = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            double age = now - Convert.ToInt64(rawTimestamp);
            return age >= 0 && age <= 15000;
        }
        catch { return false; }
    }

    private static string HashFile(string path)
    {
        AssertOrdinaryPath(path);
        using (SHA256 algorithm = SHA256.Create())
        using (FileStream stream = File.OpenRead(path))
            return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static void WriteServiceState(string state)
    {
        string path = Path.Combine(library, "background-service.json");
        AssertOrdinaryPath(path);
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, Json.Serialize(new Dictionary<string, object> {
                {"schemaVersion", 1}, {"state", state}, {"workspaceRoot", workspace},
                {"processId", Process.GetCurrentProcess().Id},
                {"timestampEpochMs", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds},
                {"launcherSha256", launcherSha256}, {"sourceSha256", sourceSha256}
            }), Utf8);
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    if (File.Exists(path)) File.Replace(temporary, path, null);
                    else File.Move(temporary, path);
                    break;
                }
                catch (IOException ex)
                {
                    // A status reader can temporarily deny replacement. Its
                    // sharing mode must never terminate the resident/worker.
                    if (attempt >= 9) { Log("Background heartbeat: " + ex.Message); break; }
                    Thread.Sleep(20);
                }
            }
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void Complete(Worker worker)
    {
        if (worker.Completed) return;
        try
        {
                // Draining both streams prevents verbose helpers from blocking.
                worker.Process.WaitForExit();
                string error;
                lock (worker.Errors) error = worker.Errors.ToString().Trim();
                if (error.Length != 0) Log(worker.Id + ": " + error);
                if (!File.Exists(worker.StatusPath))
                {
                    string message = "SFX helper exited before publishing a terminal result (exit " + worker.Process.ExitCode + ").";
                    if (error.Length != 0) message += " " + error;
                    if (message.Length > 1600) message = message.Substring(0, 1600);
                    AtomicJson(worker.StatusPath, new Dictionary<string, object> {
                        {"schemaVersion", 1}, {"kind", "disk-sfx"}, {"state", "error"},
                        {"requestId", worker.Id}, {"sessionId", worker.Session},
                        {"completedUtc", DateTime.UtcNow.ToString("o")},
                        {"errorCode", "sfx-helper-exit-without-status"}, {"exitCode", worker.Process.ExitCode},
                        {"error", message}, {"errors", new string[] { message }},
                        {"warningCount", 0}, {"warnings", new string[0]}, {"metadataOnly", true}
                    });
                    Log(worker.Id + ": " + message);
                }
        }
        catch (Exception ex) { Log(worker.Id + " terminal publication: " + ex.Message); }
        finally { worker.Completed = true; worker.Process.Dispose(); }
    }

    private static Worker Dispatch(string requestPath, string id, string expectedSession, string tools)
    {
        string ack = Path.Combine(library, "requests", "launch-sfx-" + id + ".json");
        string claim = Path.Combine(library, "requests", "launch-sfx-" + id + ".claim.json");
        string lockPath = Path.Combine(library, "requests", "launch-sfx-" + id + ".lock");
        FileStream lease = null;
        string session = expectedSession;
        Worker worker = null;
        try
        {
            AssertOrdinaryPath(ack);
            AssertOrdinaryPath(claim);
            AssertOrdinaryPath(lockPath);
            if (File.Exists(ack)) return null;
            try { lease = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { return null; }
            if (File.Exists(ack)) return null;
            Dictionary<string, object> request = ReadJson(requestPath);
            if (Integer(request, "schemaVersion") != 1 || Text(request, "requestId") != id)
                throw new InvalidDataException("SFX request schema or identity does not match its filename.");
            if (Text(request, "sessionId") != expectedSession) throw new InvalidDataException("The SFX request session does not match the pending launch pointer.");
            string requestWorkspace = Text(request, "workspaceRoot");
            if (!Path.IsPathRooted(requestWorkspace) || !Path.GetFullPath(requestWorkspace).TrimEnd('\\', '/').Equals(workspace.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("SFX request belongs to a different workspace.");
            string sessionRoot = Path.Combine(library, "sessions", session);
            AssertOrdinaryPath(sessionRoot);
            Directory.CreateDirectory(sessionRoot);
            string status = Path.Combine(sessionRoot, "status-sfx-" + id + ".json");
            AssertOrdinaryPath(status);
            if (File.Exists(status))
            {
                return null;
            }
            if (File.Exists(claim)) throw new InvalidOperationException("A previous launcher claimed this request; it will not be submitted again.");
            Dictionary<string, object> runtime = ReadJson(Path.Combine(library, "runtime.json"));
            string powershell = Text(runtime, "powerShellPath");
            if (!Path.IsPathRooted(powershell) || !Path.GetFileName(powershell).Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(powershell))
                throw new FileNotFoundException("PowerShell 7 is missing or invalid. Repair Codex AE from its installer.");
            AssertOrdinaryPath(powershell);
            string helper = Path.Combine(tools, "Update-AeSfxCatalog.ps1");
            AssertOrdinaryPath(helper);
            if (!File.Exists(helper)) throw new FileNotFoundException("The installed SFX helper is missing. Repair Codex AE from its installer.");
            // A persistent claim closes the launch/ack crash gap. In doubt, do
            // not execute a second worker for the same immutable request.
            AtomicJson(claim, new Dictionary<string, object> { {"schemaVersion", 1}, {"requestId", id}, {"state", "starting"} });
            worker = new Worker { Id = id, Session = session, StatusPath = status };
            ProcessStartInfo start = new ProcessStartInfo {
                FileName = powershell,
                Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " + Quote(helper) + " -RequestId " + Quote(id),
                WorkingDirectory = workspace, UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Utf8, StandardErrorEncoding = Utf8
            };
            worker.Process = new Process { StartInfo = start };
            Worker streamWorker = worker;
            worker.Process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { /* normal helper output is its status JSON */ };
            worker.Process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data == null) return;
                lock (streamWorker.Errors)
                {
                    int remaining = 8192 - streamWorker.Errors.Length;
                    if (remaining > 0) streamWorker.Errors.Append(e.Data, 0, Math.Min(remaining, e.Data.Length));
                    if (streamWorker.Errors.Length < 8192) streamWorker.Errors.Append('\n');
                }
            };
            if (!worker.Process.Start()) throw new InvalidOperationException("The SFX helper did not start.");
            // Ownership begins at Start(), before readers or result publication.
            // A later failure must not detach an already running child.
            worker.Started = true;
            // Inventory is background metadata work. Let AE preview/editing and
            // explicit chat/tool work win CPU contention during a large scan.
            // Priority is best-effort; it never changes dispatch/result safety.
            try { worker.Process.PriorityClass = ProcessPriorityClass.BelowNormal; }
            catch (Exception ex) { Log(id + " SFX priority: " + ex.Message); }
            StartReaders(worker);
            AtomicJson(ack, new Dictionary<string, object> { {"schemaVersion", 1}, {"requestId", id}, {"sessionId", session}, {"state", "launched"}, {"processId", worker.Process.Id} });
            return worker;
        }
        catch (Exception ex)
        {
            Log(id + ": " + ex.Message);
            try { AtomicJson(ack, new Dictionary<string, object> { {"schemaVersion", 1}, {"requestId", id}, {"sessionId", session}, {"state", "error"}, {"error", ex.Message} }); }
            catch (Exception publishError) { Log(id + " launch status: " + publishError.Message); }
            if (worker != null && worker.Started)
            {
                try { StartReaders(worker); }
                catch (Exception readerError) { Log(id + " worker output: " + readerError.Message); }
                return worker;
            }
            if (worker != null && worker.Process != null) worker.Process.Dispose();
            return null;
        }
        finally { if (lease != null) lease.Dispose(); }
    }

    private static void StartReaders(Worker worker)
    {
        if (!worker.OutputDrainStarted)
        {
            worker.Process.BeginOutputReadLine();
            worker.OutputDrainStarted = true;
        }
        if (!worker.ErrorDrainStarted)
        {
            worker.Process.BeginErrorReadLine();
            worker.ErrorDrainStarted = true;
        }
    }

    private static string Quote(string value)
    {
        // CommandLineToArgvW escaping, passed straight to CreateProcess; &, %
        // and apostrophes are ordinary filename characters, never shell code.
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            slashes = 0;
            result.Append(c);
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static Dictionary<string, object> ReadJson(string path)
    {
        return ReadJson(path, 65536);
    }

    private static Dictionary<string, object> ReadJson(string path, int limit)
    {
        AssertOrdinaryPath(path);
        if (new FileInfo(path).Length > limit) throw new InvalidDataException("Launcher metadata exceeds its size limit.");
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (StreamReader reader = new StreamReader(stream, Utf8))
            return Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
    }

    private static string Text(Dictionary<string, object> value, string key)
    {
        object found;
        if (value == null || !value.TryGetValue(key, out found) || !(found is string) || ((string)found).Length == 0)
            throw new InvalidDataException("Missing launcher metadata: " + key);
        return (string)found;
    }

    private static int Integer(Dictionary<string, object> value, string key)
    {
        object found;
        return value != null && value.TryGetValue(key, out found) && found is int ? (int)found : -1;
    }

    private static void AtomicJson(string path, object value)
    {
        AssertOrdinaryPath(path);
        if (File.Exists(path)) return;
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, Json.Serialize(value), Utf8);
            try { File.Move(temporary, path); }
            catch (IOException) { if (!File.Exists(path)) throw; }
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void AssertOrdinaryPath(string path)
    {
        string cursor = Path.GetFullPath(path);
        while (!String.IsNullOrEmpty(cursor))
        {
            if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Symbolic links and reparse points are not permitted: " + cursor);
            DirectoryInfo parent = Directory.GetParent(cursor);
            cursor = parent == null ? null : parent.FullName;
        }
    }

    private static void Log(string message)
    {
        if (String.IsNullOrEmpty(library)) return;
        try
        {
            string path = Path.Combine(library, "launcher-errors.log");
            AssertOrdinaryPath(path);
            if (!Directory.Exists(library)) return;
            // The tiny shared log must never interfere with terminal results.
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    using (FileStream stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read))
                    {
                        if (stream.Length > 131072) stream.SetLength(0);
                        stream.Seek(0, SeekOrigin.End);
                        byte[] bytes = Utf8.GetBytes(DateTime.UtcNow.ToString("o") + " " + message.Replace("\0", "") + Environment.NewLine);
                        stream.Write(bytes, 0, bytes.Length);
                    }
                    break;
                }
                catch (IOException) { Thread.Sleep(20); }
            }
        }
        catch { }
    }
}
