# 在 Guest 内用 Job Object（KILL_ON_JOB_CLOSE）启动 Guest Agent。
param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$RunDir = 'C:\awp-run'
)

$ErrorActionPreference = 'Stop'
$env:AWP_RUN_DIR = $RunDir

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AwpJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfo);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  public static void KillOnClose(IntPtr job) {
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    int size = Marshal.SizeOf(info);
    IntPtr ptr = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      if (!SetInformationJobObject(job, 9, ptr, (uint)size)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally { Marshal.FreeHGlobal(ptr); }
  }
}
"@

$job = [AwpJob]::CreateJobObject([IntPtr]::Zero, ('awp-guest-' + [guid]::NewGuid().ToString('n')))
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
[AwpJob]::KillOnClose($job)
$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { throw "Guest 找不到 node.exe" }
$p = Start-Process -FilePath $node -ArgumentList @($File) -WorkingDirectory $RunDir -PassThru -NoNewWindow
if (-not [AwpJob]::AssignProcessToJobObject($job, $p.Handle)) {
  $win32 = New-Object System.ComponentModel.Win32Exception ([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  throw "AssignProcessToJobObject failed: $($win32.Message)"
}
$p.WaitForExit()
$exit = $p.ExitCode
# 无论成功或崩溃，都在 VM 上下文里强制关机：宿主等待循环只认 state=Off 判结束，
# 若 agent 在自关机逻辑（index.mjs finally）之外崩溃（如 ERR_MODULE_NOT_FOUND 链接期就挂），
# VM 不关会把一次秒级失败拖成 WaitMinutes(45min) 空等，即云端测试“卡住没行动”的放大器。
if ($env:AWP_GUEST_VM -eq '1') {
  try {
    $outDir = Join-Path $RunDir 'output'
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    if ($exit -ne 0) {
      Add-Content -LiteralPath (Join-Path $outDir 'boot.log') ("[$(Get-Date -Format o)] agent-exit-$exit force-shutdown")
      $done = Join-Path $outDir 'AGENT_DONE'
      if (-not (Test-Path $done)) { Set-Content -LiteralPath $done ("crash exit=$exit $(Get-Date -Format o)") }
    }
  } catch { }
  shutdown.exe /s /t 5 /f /c 'awp-lane-end'
}
if ($exit -ne 0) { throw "guest-agent exit $exit" }
