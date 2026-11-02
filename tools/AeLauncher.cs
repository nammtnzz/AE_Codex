using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Small Windows entry point. Installation lives in the reviewed
// PowerShell backend; this executable never downloads or evaluates remote code.
internal static class AeLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool check = args.Length == 1 && args[0] == "--check";
        if (args.Length != 0 && !check) return 3;
        try
        {
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            string package = ResolvePackage(root);
            string manager = Path.Combine(package, "payload", "tools", "Manage-AeInstallation.ps1");
            ValidatePackage(package, manager);
            if (check) return 0;
            string shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo info = new ProcessStartInfo(shell,
                "-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File \"" + manager + "\"");
            info.WorkingDirectory = package;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process process = Process.Start(info)) { process.WaitForExit(); return process.ExitCode; }
        }
        catch (Exception error)
        {
            if (!check) MessageBox.Show("Không thể mở Codex AE.\n" + error.Message + "\nHãy giải nén đầy đủ bộ cài Codex AE rồi thử lại.", "Codex AE", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 30 };
    private static readonly Regex PackageId = new Regex("^[0-9]+\\.[0-9]+\\.[0-9]+-[0-9a-f]{12}$", RegexOptions.CultureInvariant);

    private static string ResolvePackage(string root)
    {
        AssertOrdinary(root);
        // The same executable works in an extracted share package and at the
        // development root. Root mode reads only a constrained local pointer.
        string payload = Path.Combine(root, "payload");
        if (Directory.Exists(payload)) return root;
        string pointer = Path.Combine(root, ".ae-codex", "releases", "latest.json");
        Dictionary<string, object> latest = ReadJson(pointer);
        if (Text(latest, "schema") != "codex-ae-release-build/v1" || Text(latest, "state") != "success")
            throw new InvalidDataException("Thông tin bản cài cục bộ không hợp lệ.");
        string id = Text(latest, "packageId");
        if (!PackageId.IsMatch(id)) throw new InvalidDataException("Mã bản cài cục bộ không hợp lệ.");
        // Never follow packagePath/launcherPath from a different machine.
        string package = Path.Combine(root, ".ae-codex", "releases", "CodexAE-" + id);
        AssertOrdinary(package);
        Dictionary<string, object> manifest = ReadJson(Path.Combine(package, "payload", "distribution.json"));
        if (Text(manifest, "packageId") != id) throw new InvalidDataException("Mã bản cài không khớp với thông tin cục bộ.");
        return package;
    }

    private static void ValidatePackage(string package, string manager)
    {
        AssertOrdinary(manager);
        Dictionary<string, object> manifest = ReadJson(Path.Combine(package, "payload", "distribution.json"));
        if (Text(manifest, "schema") != "codex-ae-distribution/v1" || !PackageId.IsMatch(Text(manifest, "packageId")))
            throw new InvalidDataException("Danh sách thành phần của bộ cài Codex AE không hợp lệ.");
        object rawFiles;
        if (!manifest.TryGetValue("files", out rawFiles)) throw new InvalidDataException("Bộ cài Codex AE thiếu danh sách tệp.");
        System.Collections.IEnumerable files = rawFiles as System.Collections.IEnumerable;
        if (files == null) throw new InvalidDataException("Danh sách tệp Codex AE không hợp lệ.");
        foreach (string required in new string[] { "tools/Manage-AeInstallation.ps1", "tools/Install-AeDistribution.ps1", "tools/Uninstall-AeDistribution.ps1" })
        {
            Dictionary<string, object> match = null;
            foreach (object rawFile in files)
            {
                Dictionary<string, object> file = rawFile as Dictionary<string, object>;
                if (file != null && Text(file, "path") == required)
                {
                    if (match != null) throw new InvalidDataException("Bộ cài có thông tin khởi chạy bị trùng.");
                    match = file;
                }
            }
            if (match == null) throw new InvalidDataException("Bộ cài thiếu thành phần khởi chạy: " + required);
            string path = Path.Combine(package, "payload", required.Replace('/', Path.DirectorySeparatorChar));
            AssertOrdinary(path);
            object rawSize;
            if (!match.TryGetValue("bytes", out rawSize) || !(rawSize is int || rawSize is long)) throw new InvalidDataException("Kích thước thành phần khởi chạy không hợp lệ.");
            if (new FileInfo(path).Length != Convert.ToInt64(rawSize) || Hash(path) != Text(match, "sha256"))
                throw new InvalidDataException("Thành phần khởi chạy đã bị thay đổi: " + required);
        }
    }

    private static Dictionary<string, object> ReadJson(string path)
    {
        AssertOrdinary(path);
        if (new FileInfo(path).Length > 2097152) throw new InvalidDataException("Thông tin khởi chạy Codex AE vượt giới hạn kích thước.");
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    }

    private static string Text(Dictionary<string, object> item, string key)
    {
        object value;
        if (item == null || !item.TryGetValue(key, out value) || !(value is string) || ((string)value).Length == 0)
            throw new InvalidDataException("Thông tin Codex AE thiếu trường " + key + ".");
        return (string)value;
    }

    private static string Hash(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream stream = File.OpenRead(path))
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static void AssertOrdinary(string path)
    {
        string cursor = Path.GetFullPath(path);
        while (!String.IsNullOrEmpty(cursor))
        {
            if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Codex AE không thể khởi chạy qua đường dẫn liên kết: " + cursor);
            DirectoryInfo parent = Directory.GetParent(cursor);
            cursor = parent == null ? null : parent.FullName;
        }
    }
}
