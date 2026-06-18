<#
Installs the tracker agent as a Windows scheduled task running as SYSTEM
(so deployment installers can run silently with admin rights).

Run from an elevated PowerShell prompt on the render node:

    .\install-windows-task.ps1 -Server "http://TRACKER-HOST:4400" -Key "PASTE_AGENT_KEY_HERE"

Requires Python 3.8+ on the node (https://www.python.org/downloads/ — check
"Add python.exe to PATH" during install, or pass -Python with the full path).
#>
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$Key,
    [string]$Python = "python",
    [int]$Interval = 60
)

$dest = "C:\ProgramData\TrackerAgent"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force "$PSScriptRoot\render_agent.py" "$dest\render_agent.py"

$action = New-ScheduledTaskAction -Execute $Python `
    -Argument "`"$dest\render_agent.py`" --server `"$Server`" --key `"$Key`" --interval $Interval"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable

Register-ScheduledTask -TaskName "TrackerAgent" -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName "TrackerAgent"
Write-Host "TrackerAgent task installed and started. It will also start automatically at boot."
