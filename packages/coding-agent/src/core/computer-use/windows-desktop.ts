import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const WINDOWS_DESKTOP_PROBE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class LunrDesktopProbe {
 [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, uint length, out uint needed);
 [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out uint bytes);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
 public static bool Ready() {
  int session = Process.GetCurrentProcess().SessionId;
  if (session == 0) return false;
  IntPtr buffer; uint bytes;
  if (!WTSQuerySessionInformation(IntPtr.Zero, session, 8, out buffer, out bytes)) return false;
  try { if (bytes < 4 || Marshal.ReadInt32(buffer) != 0) return false; }
  finally { WTSFreeMemory(buffer); }
  IntPtr desktop = OpenInputDesktop(0, false, 1);
  if (desktop == IntPtr.Zero) return false;
  try {
   var name = new StringBuilder(256); uint needed;
   return GetUserObjectInformation(desktop, 2, name, 512, out needed) && name.ToString() == "Default";
  } finally { CloseDesktop(desktop); }
 }
}
'@
if ([LunrDesktopProbe]::Ready()) { 'ready' } else { 'unavailable' }
`;

export async function assertInteractiveDesktop(signal?: AbortSignal): Promise<void> {
	if (process.platform !== "win32") return;
	const command = join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const { stdout } = await exec(command, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DESKTOP_PROBE], {
		timeout: 5000,
		windowsHide: true,
		signal,
	});
	if (stdout.trim() !== "ready")
		throw new Error(
			"Computer use requires an active, unlocked Windows desktop. No login, unlock, or elevation is attempted.",
		);
}
