#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$SmokeTest,
    [string]$PreviewPath,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AE_Codex')
)
# This bootstrap intentionally runs on Windows PowerShell before PowerShell 7 is installed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$payloadRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-SetupPowerShellCandidates {
    param(
        [string[]]$ProgramRoots = @($env:ProgramW6432,$env:ProgramFiles,${env:ProgramFiles(x86)}),
        [string]$LocalRoot = $env:LOCALAPPDATA,
        [string]$UserRoot = [Environment]::GetFolderPath('UserProfile')
    )
    $candidates = New-Object 'Collections.Generic.List[string]'
    foreach ($command in @(Get-Command pwsh -All -CommandType Application -ErrorAction SilentlyContinue)) {
        if ($command.Source) { $candidates.Add([string]$command.Source) }
    }
    foreach ($programRoot in @($ProgramRoots | Where-Object { $_ } | Select-Object -Unique)) {
        $candidates.Add((Join-Path $programRoot 'PowerShell/7/pwsh.exe'))
    }
    if ($LocalRoot) {
        $candidates.Add((Join-Path $LocalRoot 'Microsoft/PowerShell/7/pwsh.exe'))
        $candidates.Add((Join-Path $LocalRoot 'Programs/PowerShell/7/pwsh.exe'))
    }
    if ($UserRoot) {
        $candidates.Add((Join-Path $UserRoot 'scoop/apps/pwsh/current/pwsh.exe'))
        $candidates.Add((Join-Path $UserRoot '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'))
    }
    # Enumerate only known locations. Explorer can lack Codex's private PATH;
    # never recursively search user folders or start a process just to probe.
    return @($candidates | Select-Object -Unique)
}
function Test-SetupPowerShell7([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
        $major = $version.ProductMajorPart
        if ($major -eq 0) { $major = $version.FileMajorPart }
        return $major -ge 7
    } catch { return $false }
}
function Find-SetupDependency([string]$Name) {
    if ($Name -eq 'pwsh') {
        foreach ($candidate in @(Get-SetupPowerShellCandidates)) {
            if (Test-SetupPowerShell7 $candidate) { return $candidate }
        }
        return $null
    }
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return $command.Source }
    return $null
}
function Get-SetupAeVersions {
    $versions = @{}
    $settings = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Adobe/After Effects'
    if (Test-Path -LiteralPath $settings -PathType Container) {
        foreach ($directory in Get-ChildItem -LiteralPath $settings -Directory) { if ($directory.Name -match '^\d+\.\d+$') { $versions[$directory.Name] = $true } }
    }
    foreach ($programRoot in @($env:ProgramW6432,$env:ProgramFiles) | Where-Object { $_ } | Select-Object -Unique) {
        $adobeRoot = Join-Path $programRoot 'Adobe'
        if (-not (Test-Path -LiteralPath $adobeRoot -PathType Container)) { continue }
        foreach ($directory in Get-ChildItem -LiteralPath $adobeRoot -Directory -Filter '*After Effects*') {
            $executable = Join-Path $directory.FullName 'Support Files/AfterFX.exe'
            if (Test-Path -LiteralPath $executable -PathType Leaf) {
                $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable).ProductVersion
                if ($version -match '^(\d+\.\d+)') { $versions[$Matches[1]] = $true }
            }
        }
    }
    return @($versions.Keys | Sort-Object { [version]$_ } -Descending)
}
$pwshPath = Find-SetupDependency 'pwsh'
$nodePath = Find-SetupDependency 'node'
$codexPath = Find-SetupDependency 'codex'
$codexHomePath = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' } else { $env:CODEX_HOME }
$codexConfigPath = [IO.Path]::GetFullPath((Join-Path $codexHomePath 'config.toml'))
$manifest = $null
$manifestError = $null
try {
    $manifest = [IO.File]::ReadAllText((Join-Path $payloadRoot 'distribution.json')) | ConvertFrom-Json
    if ($manifest.schema -cne 'codex-ae-distribution/v1') { throw 'Định dạng bộ cài không được hỗ trợ.' }
} catch { $manifestError = 'Không đọc được thông tin bộ cài. Vui lòng giải nén lại Codex AE. Chi tiết: ' + $_.Exception.Message }
$aeVersions = @(Get-SetupAeVersions)
if ($Check) {
    [pscustomobject]@{schema='codex-ae-manager-check/v1';state=$(if($manifestError){'error'}else{'ready'});packageVersion=$(if($manifest){$manifest.version}else{$null});manifestError=$manifestError;powerShell7Available=[bool]$pwshPath;nodeAvailable=[bool]$nodePath;codexCliAvailable=[bool]$codexPath;codexCliRequired=$false;codexConfigPath=$codexConfigPath;codexConfigExists=(Test-Path -LiteralPath $codexConfigPath -PathType Leaf);afterEffectsVersions=$aeVersions;installRoot=[IO.Path]::GetFullPath($InstallRoot)} | ConvertTo-Json -Depth 4
    if ($manifestError) { exit 1 }
    exit 0
}
# Use Windows' bundled WinForms host for the UI; the actual installer still runs on PowerShell 7.
if ($PSVersionTable.PSEdition -eq 'Core') {
    $windowsPowerShell=Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw 'Cửa sổ cài đặt Codex AE cần Windows PowerShell 5.1.' }
    $bootstrapArguments=@('-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-InstallRoot',$InstallRoot)
    if($SmokeTest){$bootstrapArguments+='-SmokeTest'}
    if($PreviewPath){$bootstrapArguments+=@('-PreviewPath',$PreviewPath)}
    & $windowsPowerShell @bootstrapArguments
    exit $LASTEXITCODE
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$cartoonControls=@'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;
namespace CodexAeSetup {
    public static class Theme {
        public static readonly Color Background = Color.FromArgb(24, 26, 33);
        public static readonly Color Surface = Color.FromArgb(33, 36, 46);
        public static readonly Color Raised = Color.FromArgb(41, 45, 58);
        public static readonly Color Field = Color.FromArgb(22, 25, 33);
        public static readonly Color Text = Color.FromArgb(237, 240, 249);
        public static readonly Color Muted = Color.FromArgb(163, 172, 191);
        public static readonly Color Outline = Color.FromArgb(67, 74, 94);
        public static readonly Color Shadow = Color.FromArgb(13, 15, 21);
        public static readonly Color Purple = Color.FromArgb(103, 83, 175);
        public static readonly Color Blue = Color.FromArgb(54, 105, 165);
        public static readonly Color Green = Color.FromArgb(50, 112, 93);
        public static readonly Color Rose = Color.FromArgb(125, 75, 102);
        public static readonly Color Link = Color.FromArgb(145, 190, 255);
        public static readonly Color Focus = Color.FromArgb(180, 164, 245);
        public static readonly Color Disabled = Color.FromArgb(47, 51, 64);
        public static readonly Color DisabledText = Color.FromArgb(131, 141, 161);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("uxtheme.dll", CharSet=CharSet.Unicode)] private static extern int SetWindowTheme(IntPtr hwnd, string subAppName, string subIdList);
        [DllImport("gdi32.dll")] private static extern int SetBkColor(IntPtr dc, int color);
        [DllImport("gdi32.dll")] private static extern int SetTextColor(IntPtr dc, int color);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateSolidBrush(int color);
        private static int ColorRef(Color color){return color.R|(color.G<<8)|(color.B<<16);}
        private static readonly IntPtr FieldBrush=CreateSolidBrush(ColorRef(Field));
        public static IntPtr EditColors(IntPtr dc,bool enabled){SetBkColor(dc,ColorRef(Field));SetTextColor(dc,ColorRef(enabled?Text:DisabledText));return FieldBrush;}
        public static void DarkTitleBar(IntPtr handle) {
            try { int enabled=1; if(DwmSetWindowAttribute(handle,20,ref enabled,4)!=0) DwmSetWindowAttribute(handle,19,ref enabled,4); } catch { }
        }
        public static void DarkNativeControl(IntPtr handle) {
            try { SetWindowTheme(handle,"DarkMode_Explorer",null); } catch { }
        }
    }
    public static class Ink {
        public static readonly Color Outline = Theme.Outline;
        public static GraphicsPath Round(RectangleF rect, float radius) {
            GraphicsPath path = new GraphicsPath(); float d = radius * 2;
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90); path.CloseFigure(); return path;
        }
        public static void Card(Graphics g, RectangleF rect, Color color, float radius) {
            using (GraphicsPath path = Round(rect, radius))
            using (SolidBrush fill = new SolidBrush(color))
            using (Pen pen = new Pen(Outline, 2.5f)) { g.FillPath(fill, path); g.DrawPath(pen, path); }
        }
        public static void Star(Graphics g, float x, float y, float radius, Color color) {
            PointF[] points = new PointF[8];
            for (int i = 0; i < 8; i++) {
                double angle = Math.PI * i / 4 - Math.PI / 2;
                float r = i % 2 == 0 ? radius : radius * .34f;
                points[i] = new PointF(x + (float)Math.Cos(angle) * r, y + (float)Math.Sin(angle) * r);
            }
            using (SolidBrush fill = new SolidBrush(color))
            using (Pen pen = new Pen(Outline, 2.2f)) { g.FillPolygon(fill, points); g.DrawPolygon(pen, points); }
        }
    }
    public class CartoonForm : Form {
        public bool PassivePreview { get; set; }
        protected override bool ShowWithoutActivation { get { return PassivePreview || base.ShowWithoutActivation; } }
        public CartoonForm() { DoubleBuffered = true; }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Theme.DarkTitleBar(Handle); }
        protected override void WndProc(ref Message m){
            if((m.Msg==0x0133||m.Msg==0x0138)&&Control.FromHandle(m.LParam) is CartoonTextBox){Control edit=Control.FromHandle(m.LParam);m.Result=Theme.EditColors(m.WParam,edit.Enabled);return;}
            base.WndProc(ref m);
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e); Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            Ink.Card(g, new RectangleF(22, 103, 831, 67), Theme.Surface, 15);
            Ink.Card(g, new RectangleF(22, 175, 831, 85), Theme.Surface, 15);
            Ink.Card(g, new RectangleF(25, 564, ClientSize.Width - 54, ClientSize.Height - 641), Theme.Field, 12);
            Ink.Star(g, 619, 39, 12, Theme.Blue);
            Ink.Star(g, 677, 24, 8, Theme.Green);
            Ink.Card(g, new RectangleF(716, 18, 134, 41), Theme.Purple, 18);
            using (Font font = new Font("Comic Sans MS", 11, FontStyle.Bold))
            using (SolidBrush brush = new SolidBrush(Theme.Text)) {
                g.DrawString("CHÀO, AE!", font, brush, new PointF(736, 27));
            }
            using (Pen pen = new Pen(Ink.Outline, 2.2f)) {
                g.DrawLine(pen, 657, 52, 669, 49); g.DrawLine(pen, 662, 44, 664, 56);
            }
        }
    }
    public class CartoonButton : Button {
        private bool hovered, pressed;
        public CartoonButton() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true); FlatStyle = FlatStyle.Flat; Cursor = Cursors.Hand; }
        protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovered = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnPaint(PaintEventArgs e) {
            Graphics g=e.Graphics; g.SmoothingMode=SmoothingMode.AntiAlias; g.Clear(Parent.BackColor);
            float offset=pressed?2:0;
            using(GraphicsPath shadow=Ink.Round(new RectangleF(2,5,Width-5,Height-7),10))
            using(SolidBrush brush=new SolidBrush(Theme.Shadow)){g.FillPath(brush,shadow);}
            Color fill=Enabled?BackColor:Theme.Disabled;
            if(hovered&&Enabled){fill=ControlPaint.Light(fill,.12f);}
            Ink.Card(g,new RectangleF(1,1+offset,Width-5,Height-7),fill,10);
            Rectangle text=new Rectangle(3, (int)offset, Width-7, Height-5);
            TextRenderer.DrawText(g,Text,Font,text,Enabled?Theme.Text:Theme.DisabledText,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis);
            if(Focused&&Enabled){ControlPaint.DrawFocusRectangle(g,new Rectangle(8,7,Width-20,Height-18),Theme.Focus,fill);}
        }
    }
    public class CartoonGroupBox : GroupBox {
        public CartoonGroupBox() { SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true); }
        protected override void OnPaint(PaintEventArgs e) {
            Graphics g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.Clear(Parent.BackColor);
            Ink.Card(g,new RectangleF(2,9,Width-5,Height-12),BackColor,15);
            Size text=TextRenderer.MeasureText(Text,Font);
            using(SolidBrush brush=new SolidBrush(Parent.BackColor)){g.FillRectangle(brush,15,0,text.Width+8,text.Height);}
            TextRenderer.DrawText(g,Text,Font,new Point(19,0),Enabled?Theme.Text:Theme.DisabledText);
        }
    }
    public class CartoonRadio : RadioButton {
        private bool hovered;
        public CartoonRadio() { SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true); Cursor=Cursors.Hand; }
        protected override void OnMouseEnter(EventArgs e){hovered=true;Invalidate();base.OnMouseEnter(e);}
        protected override void OnMouseLeave(EventArgs e){hovered=false;Invalidate();base.OnMouseLeave(e);}
        protected override void OnPaint(PaintEventArgs e){
            Graphics g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.Clear(BackColor);
            using(SolidBrush brush=new SolidBrush(Theme.Field)){g.FillEllipse(brush,2,5,15,15);}
            using(Pen pen=new Pen(Enabled&&(hovered||Checked)?Theme.Focus:Theme.Outline,1.8f)){g.DrawEllipse(pen,2,5,15,15);}
            if(Checked){using(SolidBrush brush=new SolidBrush(Enabled?Theme.Focus:Theme.DisabledText)){g.FillEllipse(brush,6,9,7,7);}}
            TextRenderer.DrawText(g,Text,Font,new Rectangle(24,0,Width-24,Height),Enabled?Theme.Text:Theme.DisabledText,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis);
            if(Focused&&Enabled){ControlPaint.DrawFocusRectangle(g,new Rectangle(22,2,Width-25,Height-4),Theme.Focus,BackColor);}
        }
    }
    public class CartoonLabel : Label {
        protected override void OnPaint(PaintEventArgs e){TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,Enabled?ForeColor:Theme.DisabledText,TextFormatFlags.Left|TextFormatFlags.Top|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);}
    }
    public class CartoonListBox : ListBox {
        public CartoonListBox(){DrawMode=DrawMode.OwnerDrawFixed;ItemHeight=22;BorderStyle=BorderStyle.FixedSingle;BackColor=Theme.Field;ForeColor=Theme.Text;}
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);Theme.DarkNativeControl(Handle);}
        protected override void OnDrawItem(DrawItemEventArgs e){
            bool selected=(e.State&DrawItemState.Selected)!=0;
            using(SolidBrush brush=new SolidBrush(selected&&Enabled?Theme.Purple:Theme.Field)){e.Graphics.FillRectangle(brush,e.Bounds);}
            if(e.Index>=0){TextRenderer.DrawText(e.Graphics,GetItemText(Items[e.Index]),Font,e.Bounds,Enabled?Theme.Text:Theme.DisabledText,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix);}
            if((e.State&DrawItemState.Focus)!=0&&Enabled){ControlPaint.DrawFocusRectangle(e.Graphics,e.Bounds,Theme.Focus,Theme.Field);}
        }
    }
    public class CartoonComboBox : ComboBox {
        public CartoonComboBox(){DrawMode=DrawMode.OwnerDrawFixed;ItemHeight=22;FlatStyle=FlatStyle.Flat;BackColor=Theme.Field;ForeColor=Theme.Text;}
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);Theme.DarkNativeControl(Handle);}
        protected override void WndProc(ref Message m){
            if(m.Msg==0x0133||m.Msg==0x0138){m.Result=Theme.EditColors(m.WParam,Enabled);return;}
            base.WndProc(ref m);
            if(m.Msg==0x000F){using(Graphics g=Graphics.FromHwnd(Handle)){DrawArrow(g);}}
            if((m.Msg==0x0317||m.Msg==0x0318)&&m.WParam!=IntPtr.Zero){using(Graphics g=Graphics.FromHdc(m.WParam)){DrawArrow(g);}}
        }
        private void DrawArrow(Graphics g){
            Rectangle arrow=new Rectangle(Width-21,1,20,Height-2);
            using(SolidBrush brush=new SolidBrush(Enabled?Theme.Raised:Theme.Disabled)){g.FillRectangle(brush,arrow);}
            int x=Width-11,y=Height/2;
            using(SolidBrush brush=new SolidBrush(Enabled?Theme.Text:Theme.DisabledText)){g.FillPolygon(brush,new Point[]{new Point(x-4,y-2),new Point(x+4,y-2),new Point(x,y+2)});}
        }
        protected override void OnDrawItem(DrawItemEventArgs e){
            bool selected=(e.State&DrawItemState.Selected)!=0;
            using(SolidBrush brush=new SolidBrush(selected&&Enabled?Theme.Purple:Theme.Field)){e.Graphics.FillRectangle(brush,e.Bounds);}
            string text=e.Index>=0?GetItemText(Items[e.Index]):Text;
            TextRenderer.DrawText(e.Graphics,text,Font,e.Bounds,Enabled?Theme.Text:Theme.DisabledText,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix);
        }
    }
    public class CartoonTextBox : TextBox {
        public CartoonTextBox(){BackColor=Theme.Field;ForeColor=Theme.Text;}
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);Theme.DarkNativeControl(Handle);}
        protected override void WndProc(ref Message m){
            base.WndProc(ref m);
            if(!Enabled&&m.Msg==0x000F){using(Graphics g=Graphics.FromHwnd(Handle)){DrawDisabled(g);}}
            if(!Enabled&&(m.Msg==0x0317||m.Msg==0x0318)&&m.WParam!=IntPtr.Zero){using(Graphics g=Graphics.FromHdc(m.WParam)){DrawDisabled(g);}}
        }
        private void DrawDisabled(Graphics g){
            using(SolidBrush brush=new SolidBrush(Theme.Field)){g.FillRectangle(brush,1,1,Width-2,Height-2);}
            TextRenderer.DrawText(g,Text,Font,new Rectangle(2,0,Width-4,Height),Theme.DisabledText,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix|TextFormatFlags.EndEllipsis);
        }
    }
    public class CartoonProgress : Control {
        private int value, phase;
        private ProgressBarStyle style;
        private Timer animation;
        public int Value {get{return value;}set{this.value=Math.Max(0,Math.Min(100,value));Invalidate();}}
        public ProgressBarStyle Style {get{return style;}set{style=value;animation.Enabled=value==ProgressBarStyle.Marquee;Invalidate();}}
        public CartoonProgress(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);animation=new Timer();animation.Interval=60;animation.Tick+=delegate {phase=(phase+5)%Math.Max(1,Width-40);Invalidate();};}
        protected override void OnPaint(PaintEventArgs e){
            Graphics g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.Clear(Parent.BackColor);
            Ink.Card(g,new RectangleF(1,1,Width-3,Height-3),Theme.Field,7);
            int fill=style==ProgressBarStyle.Marquee?38:(int)((Width-9)*value/100f);
            int start=style==ProgressBarStyle.Marquee?phase+4:4;
            if(fill>0){using(SolidBrush brush=new SolidBrush(Enabled?Theme.Green:Theme.Disabled)){g.FillRectangle(brush,start,4,Math.Min(fill,Width-start-4),Height-8);}}
        }
        protected override void Dispose(bool disposing){if(disposing&&animation!=null){animation.Dispose();}base.Dispose(disposing);}
    }
}
'@
if(-not ('CodexAeSetup.CartoonForm' -as [type])){Add-Type -TypeDefinition $cartoonControls -ReferencedAssemblies 'System.Windows.Forms','System.Drawing'}
$script:setupProcess = $null
$script:setupLogPath = $null
$script:setupResultPath = $null
$script:lastLogText = ''
$script:sessionOutputRoot = $null
$script:metadata = $null
$script:setupSession = $null
$script:setupOperation = 'install'
$script:uninstallArmed = $false
$script:ownedInstallation = $false
$script:completionConfirmed = $false
$script:successCloseAt = $null
$background = [CodexAeSetup.Theme]::Background
$surface = [CodexAeSetup.Theme]::Field
$foreground = [CodexAeSetup.Theme]::Text
$muted = [CodexAeSetup.Theme]::Muted
$accent = [CodexAeSetup.Theme]::Blue
$form = New-Object CodexAeSetup.CartoonForm
$form.Text = 'Codex AE'
$form.Size = New-Object Drawing.Size(900,820)
$form.MinimumSize = New-Object Drawing.Size(900,820)
$form.StartPosition = 'CenterScreen'
$form.BackColor = $background
$form.ForeColor = $foreground
$form.Font = New-Object Drawing.Font('Segoe UI',10)

function New-SetupLabel([string]$Text,[int]$X,[int]$Y,[int]$Width,[int]$Height) {
    $label = New-Object CodexAeSetup.CartoonLabel
    $label.Text=$Text; $label.Location=New-Object Drawing.Point($X,$Y); $label.Size=New-Object Drawing.Size($Width,$Height)
    $label.ForeColor=$foreground;$label.BackColor=[Drawing.Color]::Transparent
    $form.Controls.Add($label)
    return $label
}
function New-SetupButton([string]$Text,[int]$X,[int]$Y,[int]$Width,[int]$Height) {
    $button=New-Object CodexAeSetup.CartoonButton
    $button.Text=$Text; $button.Location=New-Object Drawing.Point($X,$Y); $button.Size=New-Object Drawing.Size($Width,$Height)
    $button.BackColor=[CodexAeSetup.Theme]::Purple; $button.ForeColor=$foreground
    $button.Font=New-Object Drawing.Font('Segoe UI',10,[Drawing.FontStyle]::Bold)
    $form.Controls.Add($button)
    return $button
}
function New-SetupTextBox([string]$Text,[int]$X,[int]$Y,[int]$Width) {
    $textBox=New-Object CodexAeSetup.CartoonTextBox
    $textBox.Text=$Text; $textBox.Location=New-Object Drawing.Point($X,$Y); $textBox.Size=New-Object Drawing.Size($Width,29)
    $textBox.BackColor=$surface; $textBox.ForeColor=$foreground; $textBox.BorderStyle='FixedSingle'
    $form.Controls.Add($textBox)
    return $textBox
}
$title = New-SetupLabel 'Codex AE' 28 22 440 42
$title.Font = New-Object Drawing.Font('Comic Sans MS',25,[Drawing.FontStyle]::Bold)
$packageText = if ($manifest) { 'Công cụ AE qua MCP | Phiên bản ' + $manifest.version + ' | ' + $manifest.toolCount + ' chức năng tái sử dụng' } else { 'Không đọc được thông tin bộ cài' }
$subtitle = New-SetupLabel $packageText 30 69 810 26
$subtitle.ForeColor=$muted
$installedStatus = New-SetupLabel 'Cài đặt: đang kiểm tra...' 30 110 810 25
$liveStatus = New-SetupLabel 'Hiệu ứng: đang chờ kết nối After Effects' 30 138 810 25
$liveStatus.ForeColor=$muted
$null = New-SetupLabel 'Nơi cài đặt' 30 181 135 25
$installPathBox=New-SetupTextBox $InstallRoot 170 177 570
$browseInstall=New-SetupButton 'Chọn...' 752 174 100 31
$null = New-SetupLabel 'After Effects' 30 225 135 25
$versionBox=New-Object CodexAeSetup.CartoonComboBox
$versionBox.Location=New-Object Drawing.Point(170,221); $versionBox.Size=New-Object Drawing.Size(170,30)
$versionBox.DropDownStyle='DropDown'; $versionBox.BackColor=$surface; $versionBox.ForeColor=$foreground
foreach($version in $aeVersions){$null=$versionBox.Items.Add($version)}
if($aeVersions.Count){$versionBox.SelectedIndex=0}
$form.Controls.Add($versionBox)
$versionHint=New-SetupLabel 'Số phiên bản AE, ví dụ 26.5 (không phải năm sản phẩm)' 355 225 490 25
$versionHint.ForeColor=$muted

$soundGroup=New-Object CodexAeSetup.CartoonGroupBox
$soundGroup.Text='Lập danh mục hiệu ứng âm thanh trên máy này?'; $soundGroup.Location=New-Object Drawing.Point(30,269); $soundGroup.Size=New-Object Drawing.Size(822,191)
$soundGroup.ForeColor=$foreground; $soundGroup.BackColor=[CodexAeSetup.Theme]::Surface;$soundGroup.Font=New-Object Drawing.Font('Segoe UI',10,[Drawing.FontStyle]::Bold);$form.Controls.Add($soundGroup)
$soundEnable=New-Object CodexAeSetup.CartoonRadio
$soundEnable.Text='Có - chọn thư mục'; $soundEnable.Location=New-Object Drawing.Point(16,29); $soundEnable.Size=New-Object Drawing.Size(220,25)
$soundSkip=New-Object CodexAeSetup.CartoonRadio
$soundSkip.Text='Bỏ qua'; $soundSkip.Location=New-Object Drawing.Point(250,29); $soundSkip.Size=New-Object Drawing.Size(100,25); $soundSkip.Checked=$true
$soundPreserve=New-Object CodexAeSetup.CartoonRadio
$soundPreserve.Text='Giữ lựa chọn hiện tại (cập nhật)'; $soundPreserve.Location=New-Object Drawing.Point(376,29); $soundPreserve.Size=New-Object Drawing.Size(370,25)
$soundGroup.Controls.AddRange(@($soundEnable,$soundSkip,$soundPreserve))
foreach($radio in @($soundEnable,$soundSkip,$soundPreserve)){$radio.Font=New-Object Drawing.Font('Segoe UI',10);$radio.BackColor=$soundGroup.BackColor}
$soundFolders=New-Object CodexAeSetup.CartoonListBox
$soundFolders.Location=New-Object Drawing.Point(17,65); $soundFolders.Size=New-Object Drawing.Size(670,72)
$soundFolders.BackColor=$surface; $soundFolders.ForeColor=$foreground; $soundFolders.HorizontalScrollbar=$true
$soundGroup.Controls.Add($soundFolders)
$addSound=New-Object CodexAeSetup.CartoonButton
$addSound.Text='Thêm thư mục'; $addSound.Location=New-Object Drawing.Point(700,64); $addSound.Size=New-Object Drawing.Size(105,32)
$addSound.BackColor=[CodexAeSetup.Theme]::Green;$addSound.Font=New-Object Drawing.Font('Segoe UI',9,[Drawing.FontStyle]::Bold);$soundGroup.Controls.Add($addSound)
$removeSound=New-Object CodexAeSetup.CartoonButton
$removeSound.Text='Bỏ thư mục'; $removeSound.Location=New-Object Drawing.Point(700,104); $removeSound.Size=New-Object Drawing.Size(105,32)
$removeSound.BackColor=[CodexAeSetup.Theme]::Rose;$removeSound.Font=New-Object Drawing.Font('Segoe UI',9,[Drawing.FontStyle]::Bold);$soundGroup.Controls.Add($removeSound)
$soundHelp=New-Object CodexAeSetup.CartoonLabel
$soundHelp.Text='Chỉ lập danh mục, không di chuyển âm thanh. Bấm quét Effects hoặc SFX trong AE khi cần cập nhật.'
$soundHelp.Location=New-Object Drawing.Point(17,151); $soundHelp.Size=New-Object Drawing.Size(780,25); $soundHelp.ForeColor=$muted;$soundHelp.Font=New-Object Drawing.Font('Segoe UI',10)
$soundGroup.Controls.Add($soundHelp)
$installButton=New-SetupButton 'Cài đặt / Cập nhật' 30 478 170 42
$installButton.BackColor=$accent
$refreshButton=New-SetupButton 'Làm mới trạng thái' 210 478 145 42
$refreshButton.BackColor=[CodexAeSetup.Theme]::Green
$openFolder=New-SetupButton 'Mở thư mục cài đặt' 365 478 160 42
$openFolder.BackColor=[CodexAeSetup.Theme]::Purple
$uninstallButton=New-SetupButton 'Gỡ cài đặt' 535 478 145 42
$uninstallButton.BackColor=[CodexAeSetup.Theme]::Rose
$uninstallButton.Enabled=$false
$progressBar=New-Object CodexAeSetup.CartoonProgress
$progressBar.Location=New-Object Drawing.Point(700,489); $progressBar.Size=New-Object Drawing.Size(152,18)
$progressBar.Style='Continuous';$form.Controls.Add($progressBar)
$null=New-SetupLabel 'Tiến trình và lỗi' 30 539 810 25
$logBox=New-Object CodexAeSetup.CartoonTextBox
$logBox.Multiline=$true;$logBox.ScrollBars='Both';$logBox.WordWrap=$false
$logBox.Location=New-Object Drawing.Point(30,570);$logBox.Size=New-Object Drawing.Size(822,132)
$logBox.Anchor='Top, Bottom, Left, Right';$logBox.ReadOnly=$true;$logBox.BackColor=$surface;$logBox.ForeColor=$foreground
$logBox.Font=New-Object Drawing.Font('Consolas',9);$logBox.BorderStyle='None';$form.Controls.Add($logBox)
$dependencyLabel=New-SetupLabel 'Thành phần cần có:' 30 710 145 24
$dependencyLabel.ForeColor=$muted
foreach($dependencyLink in @(
    @{Text='Node.js LTS';X=185;Width=125;Url='https://nodejs.org/en/download'},
    @{Text='PowerShell 7';X=325;Width=135;Url='https://aka.ms/powershell'},
    @{Text='Codex';X=480;Width=130;Url='https://developers.openai.com/codex/app/'}
)){
    $link=New-Object Windows.Forms.LinkLabel
    $link.Text=$dependencyLink.Text;$link.Location=New-Object Drawing.Point($dependencyLink.X,710);$link.Size=New-Object Drawing.Size($dependencyLink.Width,24)
    $link.LinkColor=[CodexAeSetup.Theme]::Link;$link.ActiveLinkColor=$foreground;$link.VisitedLinkColor=[CodexAeSetup.Theme]::Focus;$link.DisabledLinkColor=[CodexAeSetup.Theme]::DisabledText;$link.Tag=$dependencyLink.Url;$link.BackColor=[Drawing.Color]::Transparent
    $link.Add_LinkClicked({param($sender,$eventArgs) try{Start-Process -FilePath ([string]$sender.Tag)}catch{Add-ManagerLog ('Không mở được trình duyệt. Chi tiết: '+$_.Exception.Message)}})
    $form.Controls.Add($link)
}
$footer=New-SetupLabel 'Gửi yêu cầu trong Codex. Tải lại MCP sau khi cài; mở AE > Codex Bridge để kết nối.' 30 742 822 27
$footer.Anchor='Bottom, Left, Right';$footer.ForeColor=$muted;$footer.Font=New-Object Drawing.Font('Segoe UI',9)

function Get-ManagerStateText([string]$State) {
    $names=@{configured='đã liên kết';disabled='đã tắt';pending='đang chờ';skipped='bỏ qua';ready='sẵn sàng';success='hoàn tất';error='lỗi';scanning='đang quét';running='đang chạy';idle='đang chờ';stopped='đã dừng';unavailable='chưa khả dụng';loading='đang tải';empty='chưa có dữ liệu';'disabled-by-config'='đã tắt';'pending-ae-connection'='đang chờ AE';'pending-manual-scan'='chờ bấm quét';'skipped-fixture'='bỏ qua trong kiểm thử'}
    if($names.ContainsKey($State)){return $names[$State]}
    return $State
}
function ConvertTo-ManagerMessage([string]$Text) {
    $translations=@{
        'Package checksums verified. Preparing the separate user installation.'='Đã kiểm tra tính toàn vẹn bộ cài. Đang chuẩn bị cài đặt riêng cho người dùng.'
        'This runtime version is already installed; preserving its working data.'='Phiên bản này đã được cài. Dữ liệu làm việc được giữ nguyên.'
        'Checking the installed bundle once; no AE project scripts are executed.'='Đang kiểm tra bộ công cụ một lần khi cài. Không chạy script chỉnh sửa dự án AE.'
        'Linking tools to this Windows user''s Codex configuration. Codex CLI is not required.'='Đang liên kết công cụ với Codex của người dùng Windows này. Không cần Codex CLI.'
        'Tools configured for Codex on this computer. Reload MCP or restart Codex once after setup.'='Đã liên kết công cụ với Codex trên máy này. Sau khi cài, tải lại MCP hoặc mở lại Codex một lần.'
        'Starting the fixed background helper and registering current-user sign-in startup.'='Đang khởi động trình hỗ trợ nền và bật tự chạy khi người dùng đăng nhập Windows.'
        'The prior runtime background startup entry was removed; its files were retained.'='Đã tắt tự khởi động trình hỗ trợ của bản cũ. Các tệp cũ vẫn được giữ lại.'
        'Use the Effects and SFX scan buttons in the AE panel when you want to update their catalogs.'='Bấm nút quét Effects hoặc SFX trong bảng AE khi bạn muốn cập nhật danh mục.'
        'Reload MCP or restart Codex once to load ae_functions on this computer. Open Window > Codex Bridge in AE and click the Effects or SFX scan button when you want a fresh catalog. If requested by AE, enable Allow Scripts to Write Files and Access Network.'='Tải lại MCP hoặc mở lại Codex một lần để nạp công cụ trên máy này. Mở Window > Codex Bridge trong AE, rồi bấm quét Effects hoặc SFX khi cần cập nhật danh mục. Nếu AE yêu cầu, bật Allow Scripts to Write Files and Access Network.'
        'Indexing sound metadata in the selected folders. No audio files are copied or imported.'='Đang lập danh mục âm thanh trong các thư mục đã chọn. Không sao chép hoặc nhập tệp âm thanh vào AE.'
        'Sound folder preference preserved or skipped.'='Đã giữ lựa chọn âm thanh hiện tại hoặc bỏ qua việc lập danh mục.'
        'Installation completed.'='Đã hoàn tất các bước cài đặt. Đang xác nhận kết quả.'
        'Node.js 20 or newer is required. Install Node.js LTS, reopen setup, then retry.'='Cần Node.js 20 trở lên. Hãy cài Node.js LTS, mở lại Codex AE rồi thử lại.'
        'Run installation with PowerShell 7 (pwsh.exe).'='Hãy chạy bộ cài bằng PowerShell 7 (pwsh.exe).'
        'After Effects was not detected. Install/open AE once, or select its numeric version (for example 26.5) in setup.'='Chưa tìm thấy After Effects. Hãy cài và mở AE một lần, hoặc chọn số phiên bản, ví dụ 26.5.'
        'After Effects version must use its numeric preference version, for example 26.5.'='Hãy nhập số phiên bản AE, ví dụ 26.5.'
        'Choose at least one sound folder, or choose Skip.'='Hãy chọn ít nhất một thư mục âm thanh hoặc chọn Bỏ qua.'
        'Choose an installation folder separate from the extracted package and source.'='Hãy chọn nơi cài đặt tách biệt với thư mục giải nén bộ cài và mã nguồn.'
        'The installation folder is inside a source checkout. Choose a separate folder.'='Nơi cài đặt đang nằm trong thư mục mã nguồn. Hãy chọn thư mục khác.'
        'Existing installation metadata is invalid; choose a separate installation folder.'='Thông tin bản cài hiện tại không hợp lệ. Hãy chọn thư mục cài đặt khác.'
        'Another setup process is active. Wait for it to finish before retrying.'='Một phiên cài đặt khác đang chạy. Hãy đợi phiên đó kết thúc rồi thử lại.'
        'Library preferences initialization failed.'='Không khởi tạo được tùy chọn thư viện.'
        'Installed bundle validation failed.'='Bộ công cụ đã cài không vượt qua bước xác minh.'
        'Codex configuration was not registered.'='Chưa đăng ký được công cụ vào cấu hình Codex.'
        'Invalid distribution manifest.'='Thông tin bộ cài không hợp lệ. Hãy giải nén lại bộ cài.'
        'Invalid package checksum or byte count.'='Mã kiểm tra hoặc kích thước tệp trong bộ cài không hợp lệ.'
        'Unsupported setup request.'='Yêu cầu cài đặt không được hỗ trợ.'
        'The existing Codex setting disables ae_functions. Its choice was preserved; enable this server in Codex MCP settings when you want to use it.'='Cấu hình Codex hiện tại đang tắt ae_functions. Lựa chọn này được giữ nguyên; hãy bật lại trong phần MCP của Codex khi cần dùng.'
        'Reload MCP or restart Codex once to load ae_functions on this computer. Open Window > Codex Bridge in AE. If requested by AE, enable Allow Scripts to Write Files and Access Network.'='Tải lại MCP hoặc mở lại Codex một lần để nạp công cụ trên máy này. Trong AE, mở Window > Codex Bridge. Nếu AE yêu cầu, bật Allow Scripts to Write Files and Access Network.'
    }
    $lines=[regex]::Split($Text,'(\r\n|\n|\r)')
    for($index=0;$index-lt $lines.Count;$index+=2){
        $line=$lines[$index];$prefix=''
        if($line-match '^(\d{2}:\d{2}:\d{2}\s+)(.*)$'){$prefix=$Matches[1];$line=$Matches[2]}
        if($translations.ContainsKey($line)){$line=$translations[$line]}
        elseif($line-match '^ERROR:\s*(.*)$'){$line='LỖI: '+(ConvertTo-ManagerMessage $Matches[1])}
        elseif($line-match '^NOTICE:\s*(.*)$'){$line='Lưu ý: '+(ConvertTo-ManagerMessage $Matches[1])}
        elseif($line-match '^Installed runtime (.+)\. Prior versions remain available\.$'){$line='Đã cài phiên bản '+$Matches[1]+'. Các phiên bản cũ vẫn được giữ lại.'}
        elseif($line-match '^AE (.+): panel and automatic startup loader installed in the user profile\.$'){$line='AE '+$Matches[1]+': đã cài bảng điều khiển và trình tự kết nối vào hồ sơ người dùng.'}
        elseif($line-match '^Codex target: (.+)$'){$line='Cấu hình Codex trên máy này: '+$Matches[1]}
        elseif($line-match '^Sound metadata indexing completed: (\d+) audio files\.$'){$line='Đã lập danh mục '+$Matches[1]+' tệp âm thanh.'}
        elseif($line-match '^AE installed; Codex registration is pending: (.+)$'){$line='Đã cài công cụ AE, nhưng chưa liên kết được Codex. Chi tiết: '+$Matches[1]}
        elseif($line-match '^Background sound updates need repair: (.+)$'){$line='Trình cập nhật âm thanh nền cần được sửa chữa. Chi tiết: '+$Matches[1]}
        elseif($line-match '^The new background helper is ready; prior runtime cleanup is pending: (.+)$'){$line='Trình hỗ trợ nền mới đã sẵn sàng; chưa dọn xong bản cũ. Chi tiết: '+$Matches[1]}
        elseif($line-match '^Installation completed; sound indexing reported: (.+)$'){$line='Đã cài công cụ, nhưng bước lập danh mục âm thanh có lỗi. Chi tiết: '+$Matches[1]}
        elseif($line-match '^Sound folder does not exist: (.+)$'){$line='Thư mục âm thanh không tồn tại: '+$Matches[1]}
        elseif($line-match '^Package verification failed: (.+)\. Extract a fresh copy of the package\.$'){$line='Tệp bộ cài không vượt qua kiểm tra: '+$Matches[1]+'. Hãy giải nén lại bộ cài.'}
        elseif($line-match '^(Package file is missing|Package manifest is incomplete|Invalid loader template|Unsafe package path|Duplicate package path|Package path escaped its root|Linked paths are not supported during installation): (.+)$'){$detail=$Matches[2];$names=@{'Package file is missing'='Thiếu tệp trong bộ cài';'Package manifest is incomplete'='Thông tin bộ cài thiếu tệp';'Invalid loader template'='Mẫu trình nạp không hợp lệ';'Unsafe package path'='Đường dẫn trong bộ cài không hợp lệ';'Duplicate package path'='Bộ cài có đường dẫn trùng';'Package path escaped its root'='Tệp nằm ngoài thư mục bộ cài';'Linked paths are not supported during installation'='Không hỗ trợ đường dẫn liên kết khi cài đặt'};$line=$names[$Matches[1]]+': '+$detail}
        elseif($line-match '^An AE job may still be active in (.+)\. Complete or resolve that job before updating; its lock was preserved\.$'){$line='AE có thể vẫn đang xử lý tại '+$Matches[1]+'. Hãy xác nhận công việc đã kết thúc trước khi cập nhật. Khóa được giữ nguyên.'}
        elseif($line-match '^An AE job has no terminal result: (.+)\. Verify completion before updating; no job was replayed\.$'){$line='Chưa có kết quả cuối cho công việc AE: '+$Matches[1]+'. Hãy xác nhận hoàn tất trước khi cập nhật; công việc không bị chạy lại.'}
        $lines[$index]=$prefix+$line
    }
    return ($lines-join '')
}
function Get-ManagerProperty($Object,[string]$Name,$Default=$null) {
    if($null-eq $Object){return $Default}
    $property=$Object.PSObject.Properties[$Name]
    if($null-eq $property){return $Default}
    return $property.Value
}
function Read-ManagerJson([string]$Path) {
    if(-not [IO.File]::Exists($Path)){throw 'Không tìm thấy tệp xác nhận cài đặt.'}
    $item=Get-Item -LiteralPath $Path
    if(($item.Attributes-band [IO.FileAttributes]::ReparsePoint)-or $item.Length-gt 1048576){throw 'Tệp xác nhận cài đặt không hợp lệ.'}
    return ([IO.File]::ReadAllText($Path)|ConvertFrom-Json)
}
function Read-ManagerProgressLog([string]$Path) {
    $stream=$null;$reader=$null
    try{
        $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite-bor [IO.FileShare]::Delete))
        $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true)
        return $reader.ReadToEnd()
    }catch [IO.IOException]{
        # A temporary sharing conflict must not block terminal-result handling.
        return $null
    }finally{
        if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}
    }
}
function Test-ManagerOwnedInstallation($Metadata,[string]$InstallRoot) {
    try{
        $installationState=[string](Get-ManagerProperty $Metadata 'state' '')
        if((Get-ManagerProperty $Metadata 'schema')-cne 'codex-ae-installation/v1'-or $installationState-ceq 'uninstalled'-or
            ((Get-ManagerProperty $Metadata 'installed' $true)-eq $false-and $installationState-cnotin @('uninstall-incomplete','uninstall-in-progress'))){return $false}
        $packageId=[string](Get-ManagerProperty $Metadata 'packageId' '')
        if($packageId-cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$'){return $false}
        return ([IO.Path]::GetFullPath([string](Get-ManagerProperty $Metadata 'runtimeRoot' ''))-ieq [IO.Path]::GetFullPath((Join-Path $InstallRoot ('versions/'+$packageId))))
    }catch{return $false}
}
function Get-ManagerCompletion([int]$ExitCode,[string]$ResultPath,$Session) {
    $completion=[ordered]@{confirmed=$false;autoClose=$false;state='error';message='Chưa xác nhận được cài đặt thành công. Cửa sổ được giữ lại để xem lỗi.';result=$null;warnings=@()}
    try{
        if($ExitCode-ne 0){throw ('Bộ cài kết thúc với mã lỗi '+$ExitCode+'.')}
        if($null-eq $Session){throw 'Không tìm thấy thông tin phiên cài đặt hiện tại.'}
        $expectedResult=[IO.Path]::GetFullPath((Join-Path $Session.outputRoot 'result.json'))
        if([IO.Path]::GetFullPath($ResultPath)-ine $expectedResult){throw 'Kết quả không thuộc phiên cài đặt hiện tại.'}
        $result=Read-ManagerJson $ResultPath
        $completion.result=$result
        if((Get-ManagerProperty $result 'schema')-cne 'codex-ae-install-result/v1'){throw 'Định dạng kết quả cài đặt không hợp lệ.'}
        if((Get-ManagerProperty $result 'state')-cne 'success'){
            $errorText=[string](Get-ManagerProperty $result 'error' 'Bước cài đặt chưa hoàn tất hoặc đã bị hủy.')
            throw (ConvertTo-ManagerMessage $errorText)
        }
        $started=([DateTime]$Session.startedUtc).ToUniversalTime()
        if([IO.File]::GetLastWriteTimeUtc($ResultPath)-lt $started.AddSeconds(-2)){throw 'Kết quả thuộc phiên cài đặt cũ; không tự đóng cửa sổ.'}
        $metadataPath=[IO.Path]::GetFullPath((Join-Path $Session.installRoot 'installation.json'))
        $runtimeRoot=[IO.Path]::GetFullPath((Join-Path $Session.installRoot ('versions/'+$Session.packageId)))
        if([IO.Path]::GetFullPath([string](Get-ManagerProperty $result 'installationPath' ''))-ine $metadataPath-or
            [IO.Path]::GetFullPath([string](Get-ManagerProperty $result 'runtimeRoot' ''))-ine $runtimeRoot){throw 'Kết quả không khớp nơi cài đặt đã chọn.'}
        if((Get-ManagerProperty $result 'version')-cne $Session.version-or (Get-ManagerProperty $result 'versionFolder')-cne $Session.versionFolder-or
            [int](Get-ManagerProperty $result 'toolCount' -1)-ne [int]$Session.toolCount){throw 'Phiên bản hoặc số công cụ đã cài không khớp bộ cài hiện tại.'}
        $metadata=Read-ManagerJson $metadataPath
        if((Get-ManagerProperty $metadata 'schema')-cne 'codex-ae-installation/v1'-or
            (Get-ManagerProperty $metadata 'packageId')-cne $Session.packageId-or
            (Get-ManagerProperty $metadata 'version')-cne $Session.version-or
            (Get-ManagerProperty $metadata 'versionFolder')-cne $Session.versionFolder-or
            [IO.Path]::GetFullPath([string](Get-ManagerProperty $metadata 'runtimeRoot' ''))-ine $runtimeRoot){throw 'Thông tin bản cài chưa xác nhận đúng phiên bản hiện tại.'}
        $installedAt=[DateTimeOffset](Get-ManagerProperty $metadata 'installedAt' '')
        if($installedAt.UtcDateTime-lt $started.AddSeconds(-2)){throw 'Thông tin bản cài thuộc phiên trước; không tự đóng cửa sổ.'}
        foreach($required in @((Join-Path $runtimeRoot 'jsx/Codex Bridge.jsx'),[string](Get-ManagerProperty $metadata 'panelPath' ''),[string](Get-ManagerProperty $metadata 'startupPath' ''))){
            if(-not $required-or -not [IO.File]::Exists($required)){throw 'Thiếu tệp công cụ hoặc trình nạp AE sau khi cài đặt.'}
        }
        $warnings=@(Get-ManagerProperty $result 'warnings' @())
        $completion.warnings=$warnings
        if($warnings.Count-gt 0-or (Get-ManagerProperty $result 'mcpState')-cne 'configured'-or (Get-ManagerProperty $metadata 'mcpState')-cne 'configured'-or
            (Get-ManagerProperty $result 'backgroundServiceState')-cne 'ready'-or (Get-ManagerProperty $metadata 'backgroundServiceState')-cne 'ready'-or
            (Get-ManagerProperty $result 'backgroundAutostartRegistered')-ne $true-or (Get-ManagerProperty $metadata 'backgroundAutostartRegistered')-ne $true){
            $completion.state='attention'
            $completion.message='Đã cài công cụ AE, nhưng còn mục cần kiểm tra. Cửa sổ được giữ lại để bạn xem nhật ký.'
            return [pscustomobject]$completion
        }
        $completion.confirmed=$true;$completion.autoClose=$true;$completion.state='success'
        $completion.message='Bạn đã cài đặt thành công!'
    }catch{$completion.message='Chưa thể xác nhận cài đặt hoàn tất. '+$_.Exception.Message}
    return [pscustomobject]$completion
}
function Get-ManagerUninstallCompletion([int]$ExitCode,[string]$ResultPath,$Session) {
    $completion=[ordered]@{confirmed=$false;autoClose=$false;state='error';message='Chưa xác nhận được việc gỡ cài đặt. Cửa sổ được giữ lại để xem lỗi.';result=$null;warnings=@()}
    try{
        if($ExitCode-ne 0){throw ('Trình gỡ cài đặt kết thúc với mã lỗi '+$ExitCode+'.')}
        if($null-eq $Session){throw 'Không tìm thấy thông tin phiên gỡ cài đặt hiện tại.'}
        if([IO.Path]::GetFullPath($ResultPath)-ine [IO.Path]::GetFullPath((Join-Path $Session.outputRoot 'result.json'))){throw 'Kết quả không thuộc phiên gỡ cài đặt hiện tại.'}
        $result=Read-ManagerJson $ResultPath
        $completion.result=$result
        if((Get-ManagerProperty $result 'schema')-cne 'codex-ae-uninstall-result/v1'-or (Get-ManagerProperty $result 'state')-cne 'success'){
            throw ([string](Get-ManagerProperty $result 'error' 'Bước gỡ cài đặt chưa hoàn tất hoặc đã bị hủy.'))
        }
        $started=([DateTime]$Session.startedUtc).ToUniversalTime()
        if([IO.File]::GetLastWriteTimeUtc($ResultPath)-lt $started.AddSeconds(-2)){throw 'Kết quả thuộc phiên gỡ cài đặt cũ; không tự đóng cửa sổ.'}
        if([IO.Path]::GetFullPath([string](Get-ManagerProperty $result 'installRoot' ''))-ine [IO.Path]::GetFullPath($Session.installRoot)-or
            [IO.Path]::GetFullPath([string](Get-ManagerProperty $result 'runtimeRoot' ''))-ine [IO.Path]::GetFullPath($Session.runtimeRoot)){throw 'Kết quả không khớp bản cài đã chọn để gỡ.'}
        $metadata=Read-ManagerJson (Join-Path $Session.installRoot 'installation.json')
        if((Get-ManagerProperty $metadata 'schema')-cne 'codex-ae-installation/v1'-or
            (Get-ManagerProperty $metadata 'packageId')-cne $Session.packageId-or
            (Get-ManagerProperty $metadata 'state')-cne 'uninstalled'-or (Get-ManagerProperty $metadata 'installed')-ne $false-or
            [IO.Path]::GetFullPath([string](Get-ManagerProperty $metadata 'runtimeRoot' ''))-ine [IO.Path]::GetFullPath($Session.runtimeRoot)){throw 'Thông tin bản cài chưa xác nhận đã gỡ đúng phiên bản.'}
        $uninstalledAt=[DateTimeOffset](Get-ManagerProperty $metadata 'uninstalledAt' '')
        if($uninstalledAt.UtcDateTime-lt $started.AddSeconds(-2)){throw 'Thông tin gỡ cài đặt thuộc phiên trước; không tự đóng cửa sổ.'}
        $completion.warnings=@(Get-ManagerProperty $result 'warnings' @())
        if($completion.warnings.Count-gt 0){$completion.state='attention';$completion.message='Đã xử lý gỡ cài đặt, nhưng còn mục cần kiểm tra. Hãy xem nhật ký bên dưới.';return [pscustomobject]$completion}
        $completion.confirmed=$true;$completion.autoClose=$true;$completion.state='success';$completion.message='Bạn đã gỡ cài đặt thành công!'
    }catch{$completion.message='Chưa thể xác nhận gỡ cài đặt hoàn tất. '+$_.Exception.Message}
    return [pscustomobject]$completion
}
function Get-ManagerCountdownState([bool]$Confirmed,[bool]$SetupRunning,[DateTime]$CloseAt,[DateTime]$Now=[DateTime]::UtcNow) {
    $seconds=[int][Math]::Max(0,[Math]::Ceiling(($CloseAt-$Now).TotalSeconds))
    return [pscustomobject]@{secondsLeft=$seconds;shouldClose=($Confirmed-and -not $SetupRunning-and $seconds-eq 0);cancelManualClose=$SetupRunning}
}
function Get-ManagerUninstallAction([bool]$Armed,[bool]$Owned,[bool]$SetupRunning) {
    if($SetupRunning-or -not $Owned){return 'none'}
    if(-not $Armed){return 'confirm'}
    return 'start'
}
function Write-ManagerCompletionReport($Completion,$Session) {
    $report=[ordered]@{schema='codex-ae-manager-completion/v1';operation=(Get-ManagerProperty $Session 'operation' 'install');state=$Completion.state;confirmed=[bool]$Completion.confirmed;autoClose=[bool]$Completion.autoClose;message=$Completion.message;verifiedAt=[DateTime]::UtcNow.ToString('o');packageId=$Session.packageId;runtimeRoot=(Get-ManagerProperty $Completion.result 'runtimeRoot');warnings=@($Completion.warnings)}
    $reportPath=Join-Path $Session.outputRoot 'completion.json'
    [IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    return $reportPath
}
function Add-ManagerLog([string]$Text) {
    $logBox.AppendText([DateTime]::Now.ToString('HH:mm:ss')+' '+(ConvertTo-ManagerMessage $Text)+[Environment]::NewLine)
    $logBox.SelectionStart=$logBox.TextLength;$logBox.ScrollToCaret()
}
function Set-SoundFolderAvailability {
    $soundFolders.Enabled=$soundEnable.Checked
    $addSound.Enabled=$soundEnable.Checked
    $removeSound.Enabled=$soundEnable.Checked
}
function Set-ManagerBusy([bool]$Busy) {
    foreach($control in @($installButton,$browseInstall,$refreshButton,$openFolder,$versionBox,$soundGroup,$installPathBox)){$control.Enabled=-not $Busy}
    $uninstallButton.Enabled=(-not $Busy-and $script:ownedInstallation)
}
function Reset-ManagerUninstallConfirmation {
    $script:uninstallArmed=$false
    $uninstallButton.Text='Gỡ cài đặt'
}
function Show-ManagerSuccessBanner($Completion,[string]$ReportPath) {
    if(-not $Completion.confirmed-or -not $Completion.autoClose-or -not [IO.File]::Exists($ReportPath)){throw 'Chưa có báo cáo xác nhận hoàn tất; không tự đóng cửa sổ.'}
    $saved=Read-ManagerJson $ReportPath
    if((Get-ManagerProperty $saved 'schema')-cne 'codex-ae-manager-completion/v1'-or (Get-ManagerProperty $saved 'confirmed')-ne $true){throw 'Báo cáo hoàn tất chưa xác nhận thành công.'}
    $progressBar.Value=100
    $nextStep=if($script:setupOperation-eq 'uninstall'){'Đã gỡ công cụ, trình nạp, liên kết và mục tự khởi động. Cấu hình, dữ liệu và bản sao lưu được giữ lại.'}else{[string](Get-ManagerProperty $Completion.result 'nextStep' 'Tải lại MCP hoặc mở lại Codex một lần; mở bảng Codex Bridge trong AE.')}
    Add-ManagerLog $nextStep
    Add-ManagerLog ('Đã lưu báo cáo xác nhận: '+$ReportPath)
    Refresh-InstalledStatus
    $installedStatus.Text=$Completion.message
    $installedStatus.Font=New-Object Drawing.Font('Segoe UI',13,[Drawing.FontStyle]::Bold)
    $installedStatus.ForeColor=[Drawing.Color]::FromArgb(153,222,183)
    $liveStatus.Text='Codex AE sẽ tự đóng sau 3 giây.'
    $installButton.Text='Đã hoàn tất'
    Set-ManagerBusy $true
    $uninstallButton.Enabled=$false
    $script:completionConfirmed=$true
    $script:successCloseAt=[DateTime]::UtcNow.AddSeconds(3)
}
function Invoke-ManagerAutoCloseTick {
    if(-not $script:completionConfirmed-or $null-eq $script:successCloseAt){return}
    $countdown=Get-ManagerCountdownState -Confirmed $script:completionConfirmed -SetupRunning ([bool]$script:setupProcess) -CloseAt $script:successCloseAt
    $liveStatus.Text='Codex AE sẽ tự đóng sau '+$countdown.secondsLeft+' giây.'
    if($countdown.shouldClose){$form.Close()}
}
function Refresh-InstalledStatus {
    $script:metadata=$null
    $script:ownedInstallation=$false
    try {
        $path=[IO.Path]::GetFullPath($installPathBox.Text)
        $metadataPath=Join-Path $path 'installation.json'
        if(Test-Path -LiteralPath $metadataPath -PathType Leaf){
            $script:metadata=[IO.File]::ReadAllText($metadataPath)|ConvertFrom-Json
            if($script:metadata.schema -cne 'codex-ae-installation/v1'){throw 'Thông tin bản cài không hợp lệ.'}
            if((Get-ManagerProperty $script:metadata 'state')-cin @('uninstall-incomplete','uninstall-in-progress')){
                $script:ownedInstallation=Test-ManagerOwnedInstallation $script:metadata $path
                $installedStatus.Text='Gỡ cài đặt chưa hoàn tất tại thư mục này'
                $liveStatus.Text='Xem nhật ký để biết lỗi. Bấm Gỡ cài đặt để thử lại; bản sao lưu và dữ liệu được giữ nguyên.'
                return
            }
            if((Get-ManagerProperty $script:metadata 'state')-ceq 'uninstalled'-or (Get-ManagerProperty $script:metadata 'installed' $true)-eq $false){
                $installedStatus.Text='Đã gỡ cài đặt Codex AE tại thư mục này'
                $liveStatus.Text='Dữ liệu và nhật ký được giữ lại. Bạn có thể cài lại khi cần.'
                return
            }
            $script:ownedInstallation=Test-ManagerOwnedInstallation $script:metadata $path
            $installedStatus.Text='Đã cài: '+$script:metadata.version+' | AE '+$script:metadata.versionFolder+' | Codex: '+(Get-ManagerStateText $script:metadata.mcpState)
            $liveStatus.Text='Danh mục Effects/SFX: mở bảng Codex Bridge trong AE rồi bấm quét khi cần'
            $libraryPath=Join-Path $script:metadata.runtimeRoot '.ae-codex/library/current.json'
            if(Test-Path -LiteralPath $libraryPath -PathType Leaf){
                $library=[IO.File]::ReadAllText($libraryPath)|ConvertFrom-Json
                $time=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$library.timestampEpochMs).LocalDateTime.ToString('g')
                $liveStatus.Text='Hiệu ứng: '+$library.effectsCount+' ('+(Get-ManagerStateText $library.effectsState)+') | Âm thanh: '+$library.sfxCount+' ('+(Get-ManagerStateText $library.sfxState)+') | '+$time
            }
        }else{$installedStatus.Text='Cài đặt: chưa có bản cài tại thư mục này';$liveStatus.Text='Danh mục Effects/SFX: bấm quét trong bảng AE sau khi cài đặt'}
    }catch{$installedStatus.Text='Không đọc được trạng thái cài đặt. Chi tiết: '+$_.Exception.Message}
    finally{$uninstallButton.Enabled=($script:ownedInstallation-and -not $script:setupProcess-and -not $script:completionConfirmed)}
}
$browseInstall.Add_Click({
    $dialog=New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description='Chọn thư mục cài đặt riêng, tách biệt với thư mục mã nguồn.'
    if(Test-Path -LiteralPath $installPathBox.Text -PathType Container){$dialog.SelectedPath=$installPathBox.Text}
    if($dialog.ShowDialog($form)-eq [Windows.Forms.DialogResult]::OK){Reset-ManagerUninstallConfirmation;$installPathBox.Text=$dialog.SelectedPath;Refresh-InstalledStatus}
    $dialog.Dispose()
})
$addSound.Add_Click({
    $dialog=New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description='Chọn một thư mục chứa hiệu ứng âm thanh của bạn.'
    if($dialog.ShowDialog($form)-eq [Windows.Forms.DialogResult]::OK -and -not $soundFolders.Items.Contains($dialog.SelectedPath)){$null=$soundFolders.Items.Add($dialog.SelectedPath)}
    $dialog.Dispose()
})
$removeSound.Add_Click({if($soundFolders.SelectedIndex -ge 0){$soundFolders.Items.RemoveAt($soundFolders.SelectedIndex)}})
$soundEnable.Add_CheckedChanged({Set-SoundFolderAvailability})
$soundSkip.Add_CheckedChanged({Set-SoundFolderAvailability})
$soundPreserve.Add_CheckedChanged({Set-SoundFolderAvailability})
$refreshButton.Add_Click({Reset-ManagerUninstallConfirmation;Refresh-InstalledStatus})
$installPathBox.Add_TextChanged({if(-not $script:setupProcess){Reset-ManagerUninstallConfirmation;Refresh-InstalledStatus}})
$openFolder.Add_Click({
    try{if(Test-Path -LiteralPath $installPathBox.Text -PathType Container){Start-Process -FilePath 'explorer.exe' -ArgumentList ('"'+[IO.Path]::GetFullPath($installPathBox.Text)+'"')}else{Add-ManagerLog 'Chọn Cài đặt / Cập nhật để tạo bản cài.'}}
    catch{Add-ManagerLog ('LỖI: '+$_.Exception.Message)}
})
$installButton.Add_Click({
    try{
        if($script:setupProcess-or $script:completionConfirmed){return}
        Reset-ManagerUninstallConfirmation
        $script:setupOperation='install'
        $script:pwshPath=Find-SetupDependency 'pwsh'
        if(-not $script:pwshPath){throw 'Cần PowerShell 7. Hãy tải tại https://aka.ms/powershell rồi mở lại Codex AE.'}
        if(-not (Find-SetupDependency 'node')){throw 'Cần Node.js 20 trở lên. Hãy cài Node.js LTS tại https://nodejs.org rồi mở lại Codex AE.'}
        if($manifestError){throw $manifestError}
        if($versionBox.Text -notmatch '^\d+\.\d+$'){throw 'Hãy chọn hoặc nhập số phiên bản AE, ví dụ 26.5.'}
        if($soundEnable.Checked -and $soundFolders.Items.Count -eq 0){throw 'Hãy thêm thư mục âm thanh hoặc chọn Bỏ qua.'}
        $target=[IO.Path]::GetFullPath($installPathBox.Text)
        $script:sessionOutputRoot=Join-Path $target ('.ae-codex/setup/manager-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
        [IO.Directory]::CreateDirectory($script:sessionOutputRoot)|Out-Null
        $script:setupLogPath=Join-Path $script:sessionOutputRoot 'progress.log'
        $script:setupResultPath=Join-Path $script:sessionOutputRoot 'result.json'
        $script:setupSession=[pscustomobject]@{operation='install';outputRoot=$script:sessionOutputRoot;installRoot=$target;packageId=$manifest.packageId;version=$manifest.version;versionFolder=$versionBox.Text;toolCount=$manifest.toolCount;startedUtc=[DateTime]::UtcNow}
        $requestPath=Join-Path $script:sessionOutputRoot 'request.json'
        $soundChoice=if($soundEnable.Checked){'Enable'}elseif($soundPreserve.Checked){'Preserve'}else{'Disable'}
        $roots=@();foreach($item in $soundFolders.Items){$roots+=[string]$item}
        $request=[ordered]@{schema='codex-ae-install-request/v1';InstallRoot=$target;VersionFolder=$versionBox.Text;SfxChoice=$soundChoice;SoundRoots=$roots;LogPath=$script:setupLogPath;ResultPath=$script:setupResultPath}
        [IO.File]::WriteAllText($requestPath,($request|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
        $backend=Join-Path $PSScriptRoot 'Install-AeDistribution.ps1'
        if($backend.Contains('"')-or $requestPath.Contains('"')){throw 'Đường dẫn bộ cài chứa dấu ngoặc kép không được hỗ trợ.'}
        $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$backend+'"'),'-RequestPath',('"'+$requestPath+'"'))
        $script:lastLogText=''
        $script:setupProcess=Start-Process -FilePath $script:pwshPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:sessionOutputRoot 'stdout.log') -RedirectStandardError (Join-Path $script:sessionOutputRoot 'stderr.log')
        Set-ManagerBusy $true
        $progressBar.Style='Marquee'
        Add-ManagerLog 'Đã bắt đầu cài đặt. Bạn có thể theo dõi tiến trình trong cửa sổ này.'
    }catch{Add-ManagerLog ('LỖI: '+$_.Exception.Message)}
})
$uninstallButton.Add_Click({
    try{
        if($script:setupProcess-or $script:completionConfirmed){return}
        Refresh-InstalledStatus
        $action=Get-ManagerUninstallAction -Armed $script:uninstallArmed -Owned $script:ownedInstallation -SetupRunning ([bool]$script:setupProcess)
        if($action-eq 'none'){throw 'Không tìm thấy bản cài Codex AE hợp lệ tại thư mục này.'}
        if($action-eq 'confirm'){
            $script:uninstallArmed=$true
            $uninstallButton.Text='Xác nhận gỡ'
            $liveStatus.Text='Gỡ công cụ và liên kết; giữ cấu hình, dữ liệu và bản sao lưu. Bấm Xác nhận gỡ để tiếp tục.'
            Add-ManagerLog 'Bấm Stop trong panel Codex Bridge và chờ mọi công việc kết thúc trước khi gỡ. Bấm Xác nhận gỡ để tiếp tục; bấm Làm mới trạng thái để hủy. Chỉ gỡ công cụ, trình nạp, liên kết và mục tự khởi động; giữ cấu hình, dữ liệu và bản sao lưu.'
            return
        }
        $script:pwshPath=Find-SetupDependency 'pwsh'
        if(-not $script:pwshPath){throw 'Cần PowerShell 7 để gỡ cài đặt Codex AE.'}
        $backend=Join-Path $PSScriptRoot 'Uninstall-AeDistribution.ps1'
        if(-not [IO.File]::Exists($backend)){throw 'Thiếu trình gỡ cài đặt. Hãy giải nén lại bộ cài Codex AE.'}
        $target=[IO.Path]::GetFullPath($installPathBox.Text)
        $script:sessionOutputRoot=Join-Path $target ('.ae-codex/setup/manager-uninstall-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
        [IO.Directory]::CreateDirectory($script:sessionOutputRoot)|Out-Null
        $script:setupLogPath=Join-Path $script:sessionOutputRoot 'progress.log'
        $script:setupResultPath=Join-Path $script:sessionOutputRoot 'result.json'
        $requestPath=Join-Path $script:sessionOutputRoot 'request.json'
        $script:setupOperation='uninstall'
        $script:setupSession=[pscustomobject]@{operation='uninstall';outputRoot=$script:sessionOutputRoot;installRoot=$target;runtimeRoot=$script:metadata.runtimeRoot;packageId=$script:metadata.packageId;startedUtc=[DateTime]::UtcNow}
        $request=[ordered]@{schema='codex-ae-uninstall-request/v1';InstallRoot=$target;LogPath=$script:setupLogPath;ResultPath=$script:setupResultPath}
        [IO.File]::WriteAllText($requestPath,($request|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
        if($backend.Contains('"')-or $requestPath.Contains('"')){throw 'Đường dẫn trình gỡ cài đặt chứa dấu ngoặc kép không được hỗ trợ.'}
        $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$backend+'"'),'-RequestPath',('"'+$requestPath+'"'))
        $script:lastLogText=''
        $script:setupProcess=Start-Process -FilePath $script:pwshPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:sessionOutputRoot 'stdout.log') -RedirectStandardError (Join-Path $script:sessionOutputRoot 'stderr.log')
        Reset-ManagerUninstallConfirmation
        Set-ManagerBusy $true
        $progressBar.Style='Marquee'
        Add-ManagerLog 'Đã bắt đầu gỡ cài đặt. Không đóng cửa sổ cho đến khi có kết quả.'
    }catch{Add-ManagerLog ('LỖI: '+$_.Exception.Message)}
})
$timer=New-Object Windows.Forms.Timer
$timer.Interval=700
$timer.Add_Tick({
    if($script:completionConfirmed-and $null-ne $script:successCloseAt){
        Invoke-ManagerAutoCloseTick
        return
    }
    if(-not $script:setupProcess){return}
    try{
        if(Test-Path -LiteralPath $script:setupLogPath -PathType Leaf){
            $text=Read-ManagerProgressLog $script:setupLogPath
            if($null-ne $text-and $text -ne $script:lastLogText){
                if($text.StartsWith($script:lastLogText)){$logBox.AppendText((ConvertTo-ManagerMessage $text.Substring($script:lastLogText.Length)))}else{$logBox.AppendText((ConvertTo-ManagerMessage $text))}
                $script:lastLogText=$text;$logBox.SelectionStart=$logBox.TextLength;$logBox.ScrollToCaret()
            }
        }
        if($script:setupProcess.HasExited){
            $exitCode=$script:setupProcess.ExitCode
            $script:setupProcess.Dispose();$script:setupProcess=$null
            Set-ManagerBusy $false
            $progressBar.Style='Continuous';$progressBar.Value=0
            $completion=if($script:setupOperation-eq 'uninstall'){Get-ManagerUninstallCompletion -ExitCode $exitCode -ResultPath $script:setupResultPath -Session $script:setupSession}else{Get-ManagerCompletion -ExitCode $exitCode -ResultPath $script:setupResultPath -Session $script:setupSession}
            # Publish the final report before announcing success or scheduling
            # a close. A failed report never causes a second installer run.
            $reportPath=Write-ManagerCompletionReport $completion $script:setupSession
            Add-ManagerLog $completion.message
            foreach($warning in @($completion.warnings)){Add-ManagerLog ('Lưu ý: '+(ConvertTo-ManagerMessage ([string]$warning)))}
            if($completion.confirmed-and $completion.autoClose){
                Show-ManagerSuccessBanner $completion $reportPath
            }else{
                if($completion.state-eq 'attention'){$progressBar.Value=100}
                $errorPath=Join-Path $script:sessionOutputRoot 'stderr.log'
                if(Test-Path -LiteralPath $errorPath -PathType Leaf){$details=[IO.File]::ReadAllText($errorPath);if(-not [string]::IsNullOrWhiteSpace($details)){Add-ManagerLog ('Chi tiết từ bộ cài: '+(ConvertTo-ManagerMessage $details))}}
                Refresh-InstalledStatus
            }
        }
    }catch{Add-ManagerLog ('LỖI khi xác nhận kết quả: '+$_.Exception.Message)}
})
$form.Add_FormClosing({param($sender,$eventArgs)
    if($script:setupProcess -and -not $script:setupProcess.HasExited){$eventArgs.Cancel=$true;Add-ManagerLog 'Bộ cài vẫn đang chạy. Hãy đợi có kết quả trước khi đóng Codex AE.'}
})
if(-not $SmokeTest){$form.Add_Shown({$form.Activate()})}
Set-SoundFolderAvailability
Refresh-InstalledStatus
if($script:metadata){$soundPreserve.Checked=$true;$versionBox.Text=$script:metadata.versionFolder}
if($manifestError){Add-ManagerLog ('LỖI: '+$manifestError);$installButton.Enabled=$false}
if(-not $pwshPath){Add-ManagerLog 'Cần cài PowerShell 7. Tải tại: https://aka.ms/powershell'}
if(-not $nodePath){Add-ManagerLog 'Cần cài Node.js 20 trở lên. Tải tại: https://nodejs.org'}
Add-ManagerLog ('Codex trên máy này: '+$codexConfigPath)
if(-not $codexPath){Add-ManagerLog 'Hỗ trợ Codex Desktop mà không cần Codex CLI. Bộ cài tự liên kết các công cụ trên máy này.'}
Add-ManagerLog 'Mở cửa sổ này không quét hiệu ứng, âm thanh hoặc thay đổi dự án AE.'
if($SmokeTest){
    try{
        # Render this process's own form off screen; no desktop capture or UI interaction.
        $form.StartPosition='Manual'
        $form.Location=New-Object Drawing.Point(-32000,-32000)
        $form.ShowInTaskbar=$false
        $form.PassivePreview=$true
        $form.Show()
        $form.PerformLayout()
        [Windows.Forms.Application]::DoEvents()
        if($PreviewPath){
            $preview=[IO.Path]::GetFullPath($PreviewPath)
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($preview))|Out-Null
            $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
            try{$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save($preview,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
        }
        [pscustomobject]@{schema='codex-ae-manager-smoke/v1';state='success';controls=$form.Controls.Count;previewPath=$PreviewPath;packageVersion=$(if($manifest){$manifest.version}else{$null});installationStarted=$false}|ConvertTo-Json
    }finally{$form.Hide();$timer.Dispose();$form.Dispose()}
    exit 0
}
$timer.Start()
try{[void]$form.ShowDialog()}
finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
