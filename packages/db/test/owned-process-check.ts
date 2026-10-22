import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export interface OwnedSnapshot { processes: { pid: number; parentPid: number; role: string }[]; listeners: number[] }
export function snapshotOwned(rootPid: number, port: number): OwnedSnapshot {
  assert(Number.isInteger(rootPid) && rootPid > 0 && Number.isInteger(port));
  if (process.platform !== 'win32') throw new Error('This ownership snapshot implementation is Windows-specific');
  const script = `$taskRoot=${rootPid}
$all=Get-CimInstance Win32_Process
$owned=@($taskRoot)
do { $added=@($all | Where-Object { $owned -contains $_.ParentProcessId -and $owned -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $owned+= $added } while ($added.Count -gt 0)
$rows=@($all | Where-Object { $owned -contains $_.ProcessId } | ForEach-Object {
  $role='owned-child'
  if ($_.CommandLine -match 'worker-entry') { $role='queue-worker-entry' }
  elseif ($_.CommandLine -match 'scripts[\\/]worker.mjs') { $role='root-worker-wrapper' }
  elseif ($_.CommandLine -match 'scripts[\\/]dev.mjs') { $role='root-dev-wrapper' }
  elseif ($_.CommandLine -match 'next') { $role='next' }
  [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;role=$role}
})
$listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Select-Object -Unique)
[pscustomobject]@{processes=$rows;listeners=$listeners} | ConvertTo-Json -Depth 4 -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }));
}
export function verifyStopped(snapshot: OwnedSnapshot, port: number) {
  const ids = snapshot.processes.map(item => item.pid);
  assert(ids.every(id => Number.isInteger(id) && id > 0));
  const script = `$survivors=@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Select-Object -Unique)
[pscustomobject]@{survivors=$survivors;listeners=$listeners} | ConvertTo-Json -Compress`;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }));
  assert.deepEqual(result, { survivors: [], listeners: [] });
  return result;
}
