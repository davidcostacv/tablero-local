<#
.SYNOPSIS
  Instala, actualiza o repara el Tablero con UN solo comando (Windows 10/11, PowerShell 5.1 o superior, sin administrador).

.DESCRIPTION
  cd $HOME\life-dashboard; powershell -ExecutionPolicy Bypass -File .\setup.ps1

  Es idempotente: se puede correr todas las veces que haga falta. Pasos:
    1. Comprueba Node.js >= 20.11 y git (si falta algo, dice cómo instalarlo con winget).
    2. git pull de la rama actual (si setup.ps1 cambió, se vuelve a ejecutar la versión nueva).
    3. Detecta el vault de Obsidian (-Vault, luego data\settings.json, luego $HOME\Claude-Memoria, luego busca una
       carpeta "10 Memoria" dentro de $HOME) y lo guarda en data\settings.json. También guarda el puerto.
    4. Importa el vault una vez (node import-vault.mjs) e instala la skill de Claude Code.
    5. Detiene el servidor anterior (el lanzador oculto y el node que escuche en el puerto; nunca otros programas).
    6. Registra la tarea programada "Tablero" (al iniciar sesión, tu usuario, sin elevar) que arranca el servidor
       OCULTO con run-hidden.vbs y lo reinicia si se cae. Si no se puede registrar, deja un acceso directo en Inicio.
    7. Arranca el servidor ahora, espera a que responda /api/meta (15 s) y abre http://localhost:<puerto>.
    8. Resume: elementos, vault, sincronización y arranque automático. El registro queda en data\server.log.

.PARAMETER Vault
  Ruta del vault de Obsidian (la carpeta Claude-Memoria que contiene "10 Memoria", "30 Conversaciones"...).
.PARAMETER Port
  Puerto del servidor (por defecto 4747, o el guardado en data\settings.json).
.PARAMETER NoAutostart
  No registra (y quita si existía) el arranque automático; solo arranca el servidor ahora.
.PARAMETER Uninstall
  Quita la tarea programada y el acceso directo, detiene el servidor y termina. Conserva data\ (tus datos).
.PARAMETER NoPull
  No hace git pull (lo usa el propio script al reejecutarse tras actualizarse).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Vault "C:\ruta\a\Claude-Memoria"
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Vault = '',
  [int]$Port = 0,
  [switch]$NoAutostart,
  [switch]$Uninstall,
  [switch]$NoPull
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Repo = $PSScriptRoot
if (-not $Repo) { $Repo = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $Repo
$DataDir = Join-Path $Repo 'data'
$SettingsFile = Join-Path $DataDir 'settings.json'
$TaskName = 'Tablero'
$Vbs = Join-Path $Repo 'run-hidden.vbs'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Tablero.lnk'
$User = "$env:USERDOMAIN\$env:USERNAME"
$script:Autostart = 'no'

function Say([string]$msg, [string]$color = '') { if ($color) { Write-Host $msg -ForegroundColor $color } else { Write-Host $msg } }
function Step([string]$msg) { Write-Host ("`n> " + $msg) -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host ("`nERROR: " + $msg) -ForegroundColor Red; exit 1 }
# Comandos nativos a través de cmd: en PowerShell 5.1, con $ErrorActionPreference = 'Stop', lo que git escribe en
# stderr (progreso) se convertiría en un error terminal. Devuelve las líneas; el código queda en $LASTEXITCODE.
function Run-Native([string]$commandLine) { $lines = @(cmd /c ($commandLine + ' 2>&1')); return $lines }

# ---------- data\settings.json (lo lee server.mjs: vault y puerto; nunca se escribe con BOM) ----------
function Read-Settings {
  $h = @{}
  if (-not (Test-Path -LiteralPath $SettingsFile)) { return $h }
  try {
    $raw = [IO.File]::ReadAllText($SettingsFile)
    $obj = $raw.TrimStart([char]0xFEFF) | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
  } catch { Say ("  Aviso: data\settings.json no se pudo leer (" + $_.Exception.Message + "); se reescribe.") Yellow }
  return $h
}
function Save-Settings([hashtable]$changes) {
  $s = Read-Settings
  foreach ($k in $changes.Keys) { if ($null -eq $changes[$k]) { $s.Remove($k) } else { $s[$k] = $changes[$k] } }
  if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  $json = ConvertTo-Json -InputObject $s -Depth 5
  [IO.File]::WriteAllText($SettingsFile, $json, (New-Object Text.UTF8Encoding $false))
}

# ---------- puerto y procesos ----------
# PIDs que escuchan en el puerto. Get-NetTCPConnection puede no existir: entonces se lee netstat (sin depender del idioma).
function Get-ListenPids([int]$p) {
  $found = @()
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try { $found = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | ForEach-Object { [int]$_.OwningProcess }) } catch { $found = @() }
  }
  if ($found.Count -eq 0) {
    # Remoto "x:0" = socket en escucha (0.0.0.0:0, [::]:0 o 127.0.0.1:0 si el servidor solo escucha en loopback).
    $rx = '[:.]' + $p + '\s+(\S+:0)\s+\S+\s+(\d+)\s*$'
    foreach ($line in @(Run-Native 'netstat -ano -p tcp')) { $m = [regex]::Match([string]$line, $rx); if ($m.Success) { $found += [int]$m.Groups[2].Value } }
    foreach ($line in @(Run-Native 'netstat -ano -p tcpv6')) { $m = [regex]::Match([string]$line, $rx); if ($m.Success) { $found += [int]$m.Groups[2].Value } }
  }
  return @($found | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}
# Detiene el lanzador oculto (para que no reinicie node), la tarea y el node que escuche en el puerto. Nunca otros programas.
function Stop-Dashboard {
  try {
    $launchers = @(Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe' OR Name = 'cscript.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-hidden.vbs*' })
    foreach ($l in $launchers) {
      # Primero el node hijo del lanzador: al matar solo el lanzador, node quedaba huérfano ocupando el puerto.
      $kids = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $l.ProcessId + " AND Name = 'node.exe'") -ErrorAction SilentlyContinue)
      Stop-Process -Id $l.ProcessId -Force -ErrorAction SilentlyContinue; Say ("  lanzador oculto detenido (PID " + $l.ProcessId + ")")
      foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue; Say ("  servidor del lanzador detenido (node, PID " + $k.ProcessId + ")") }
    }
  } catch {}
  try { if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } } catch {}
  # El propio servidor informa su PID en /api/meta (solo a loopback): es la forma más fiable de encontrarlo.
  try {
    $m = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/meta') -TimeoutSec 3 -ErrorAction Stop
    if ($m.app -eq 'life-dashboard' -and $m.pid) {
      $proc = Get-Process -Id ([int]$m.pid) -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -ieq 'node') { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Say ("  servidor anterior detenido (node, PID " + $proc.Id + ")") }
    }
  } catch {}
  Start-Sleep -Milliseconds 300
  $busy = @()
  foreach ($procId in @(Get-ListenPids $Port)) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.ProcessName -ieq 'node') { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; Say ("  servidor anterior detenido (node, PID " + $procId + ")") }
    else { $busy += ($proc.ProcessName + ' (PID ' + $procId + ')') }
  }
  Start-Sleep -Milliseconds 600
  return @($busy)
}
function Wait-Dashboard([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { $m = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/meta') -TimeoutSec 3 -ErrorAction Stop; if ($m.app -eq 'life-dashboard') { return $m } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $null
}

# ---------- arranque automático: tarea programada por usuario (sin admin) o acceso directo en Inicio ----------
function Register-Autostart {
  try {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "' + $Vbs + '"') -WorkingDirectory $Repo
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    try { $trigger.Delay = 'PT15S' } catch {}
    # Visible en el Programador de tareas (la ventana del servidor es lo que va oculto, via run-hidden.vbs).
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    try { $settings.ExecutionTimeLimit = 'PT0S' } catch {}
    try { $settings.DisallowStartOnRemoteAppSession = $false } catch {}
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User $User -RunLevel Limited -Force -ErrorAction Stop | Out-Null
    if (Test-Path -LiteralPath $Shortcut) { Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue }
    $script:Autostart = 'tarea programada "' + $TaskName + '" (al iniciar sesión, oculta, se reinicia si falla)'
    Say ('  tarea programada "' + $TaskName + '" registrada para ' + $User)
    return $true
  } catch {
    Say ('  No se pudo registrar la tarea programada (' + $_.Exception.Message.Trim() + '). Se usa la carpeta Inicio.') Yellow
  }
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($Shortcut)
    $sc.TargetPath = 'wscript.exe'
    $sc.Arguments = '//B //Nologo "' + $Vbs + '"'
    $sc.WorkingDirectory = $Repo
    $sc.WindowStyle = 7
    $sc.Description = 'Tablero (servidor local, oculto)'
    $sc.Save()
    $script:Autostart = 'acceso directo en la carpeta Inicio (' + $Shortcut + ')'
    Say '  acceso directo creado en la carpeta Inicio'
  } catch { Say ('  Tampoco se pudo crear el acceso directo: ' + $_.Exception.Message) Red }
  return $false
}
function Remove-Autostart {
  try { if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Say ('  tarea programada "' + $TaskName + '" eliminada') } } catch { Say ('  no se pudo quitar la tarea: ' + $_.Exception.Message) Yellow }
  if (Test-Path -LiteralPath $Shortcut) { Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue; Say '  acceso directo de Inicio eliminado' }
}

# ---------- vault ----------
function Find-Vault {
  if ($Vault) {
    if (-not (Test-Path -LiteralPath $Vault -PathType Container)) { Fail ('La carpeta indicada en -Vault no existe: ' + $Vault) }
    return (Resolve-Path -LiteralPath $Vault).Path
  }
  $s = Read-Settings
  if ($s.ContainsKey('vault') -and $s['vault']) {
    if (-not (Test-Path -LiteralPath $s['vault'] -PathType Container)) { Say ('  Aviso: la ruta guardada no existe ahora mismo (' + $s['vault'] + '). Se conserva; si la moviste usa -Vault "nueva ruta".') Yellow }
    return [string]$s['vault']
  }
  $def = Join-Path $HOME 'Claude-Memoria'
  if (Test-Path -LiteralPath $def -PathType Container) { return $def }
  Say ('  Buscando una carpeta "10 Memoria" dentro de ' + $HOME + ' (puede tardar un momento)...')
  $skip = @('AppData', 'node_modules', '.git', '.cache', '.npm', '.vscode', '.gradle', '.android', 'Links', 'Saved Games', 'Searches', 'Contacts', 'Favorites')
  foreach ($top in @(Get-ChildItem -LiteralPath $HOME -Directory -ErrorAction SilentlyContinue)) {
    if ($skip -contains $top.Name) { continue }
    $hit = Get-ChildItem -LiteralPath $top.FullName -Directory -Recurse -Depth 6 -Filter '10 Memoria' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.Parent.FullName }
  }
  return $null
}

# ====================================================================================================
Say ''
Say '=== Tablero: instalar / actualizar / reparar ===' Green
Say ('Repo: ' + $Repo)

# Puerto: -Port > guardado > 4747
$saved = Read-Settings
if ($Port -gt 0) { Save-Settings @{ port = $Port } }
else { $savedPort = 0; if ($saved.ContainsKey('port')) { $savedPort = $saved['port'] -as [int] }; if ($savedPort -ge 1024) { $Port = $savedPort } else { $Port = 4747 } }

# ---------- -Uninstall ----------
if ($Uninstall) {
  Step 'Quitando el arranque automático y deteniendo el servidor'
  $null = Stop-Dashboard
  Remove-Autostart
  Say ("`nListo. El servidor está detenido y ya no arranca solo. Tus datos siguen en " + $DataDir + '.') Green
  Say 'Para volver a activarlo: powershell -ExecutionPolicy Bypass -File .\setup.ps1'
  exit 0
}

# ---------- 1. requisitos ----------
Step 'Comprobando requisitos'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail "Falta Node.js (se necesita 20.11 o superior). Instálalo con:`n    winget install OpenJS.NodeJS.LTS`n  (o desde https://nodejs.org), cierra y vuelve a abrir PowerShell y corre de nuevo este script." }
$nodeVersionText = ''
try { $nodeVersionText = ([string](& node -v)).Trim().TrimStart('v') } catch {}
$nodeVersion = $null
try { $nodeVersion = [version]$nodeVersionText } catch {}
if (-not $nodeVersion) { Fail ('No se pudo leer la versión de Node.js ("node -v" devolvió: ' + $nodeVersionText + ').') }
if ($nodeVersion -lt [version]'20.11.0') { Fail ("Node.js " + $nodeVersionText + " es demasiado antiguo: se necesita 20.11 o superior. Actualízalo con:`n    winget upgrade OpenJS.NodeJS.LTS   (o winget install OpenJS.NodeJS.LTS)") }
Say ('  Node.js ' + $nodeVersionText + ' en ' + $nodeCmd.Source)
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) { Say ('  git: ' + ((Run-Native 'git --version') -join ' ')) }
else { Say "  Falta git: no se podrá actualizar el tablero. Instálalo con:  winget install Git.Git  (se sigue con la versión local)." Yellow }

# ---------- 2. git pull ----------
if ($gitCmd -and -not $NoPull -and (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
  Step 'Actualizando el repositorio (git pull)'
  $before = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
  $branch = ((Run-Native 'git rev-parse --abbrev-ref HEAD') -join '').Trim()
  $out = Run-Native 'git pull --ff-only'
  if ($LASTEXITCODE -ne 0) { Say ('  No se pudo actualizar la rama ' + $branch + ' (se sigue con la versión local): ' + (($out | Select-Object -Last 2) -join ' | ')) Yellow }
  else { Say ('  rama ' + $branch + ': ' + (($out | Select-Object -Last 1) -join '')) }
  $after = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
  if ($before -ne $after) {
    Say '  setup.ps1 se actualizó: se vuelve a ejecutar la versión nueva...' Yellow
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-NoPull')
    foreach ($k in $PSBoundParameters.Keys) {
      if ($k -eq 'NoPull') { continue }
      $v = $PSBoundParameters[$k]
      if ($v -is [switch]) { if ($v.IsPresent) { $argList += ('-' + $k) } } else { $argList += ('-' + $k); $argList += [string]$v }
    }
    & powershell.exe @argList
    exit $LASTEXITCODE
  }
}

# ---------- 3. vault ----------
Step 'Vault de Obsidian'
$vaultPath = Find-Vault
if ($vaultPath) {
  Save-Settings @{ vault = $vaultPath }
  if (Test-Path -LiteralPath $vaultPath -PathType Container) { Say ('  vault: ' + $vaultPath + ' (guardado en data\settings.json)') }
} else {
  Save-Settings @{ vault = $null }
  Say '  No se encontró ningún vault (ninguna carpeta "10 Memoria" dentro de tu perfil). El tablero funciona igual, sin importar notas.' Yellow
  Say '  Cuando sepas la ruta: powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Vault "C:\ruta\Claude-Memoria"' Yellow
}

# ---------- 4. importación inicial + skill ----------
$importLine = ''
if ($vaultPath -and (Test-Path -LiteralPath $vaultPath -PathType Container)) {
  Step 'Importando el vault'
  $env:VAULT = $vaultPath
  $out = Run-Native 'node import-vault.mjs'
  $importLine = (($out | Select-Object -Last 1) -join '')
  if ($LASTEXITCODE -ne 0) { Say ('  La importación falló (el servidor lo reintentará solo): ' + ($out -join ' | ')) Yellow } else { Say ('  ' + $importLine) }
}
try {
  $skillDir = Join-Path $HOME '.claude\skills\dashboard'
  New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $Repo 'skills\dashboard\SKILL.md') -Destination $skillDir -Force
  [IO.File]::WriteAllText((Join-Path $skillDir 'repo-path.txt'), $Repo + "`r`n", (New-Object Text.UTF8Encoding $false))
} catch {}

# ---------- 5. detener lo anterior ----------
Step ('Deteniendo el servidor anterior (puerto ' + $Port + ')')
$busy = @(Stop-Dashboard)
if ($busy.Count -gt 0) { Fail ('El puerto ' + $Port + ' lo usa otro programa: ' + ($busy -join ', ') + ". Ciérralo o usa otro puerto:`n    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Port 5000") }
# ruta de node para el lanzador (la tarea programada puede no tener el mismo PATH); ANSI porque la lee VBScript
if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
[IO.File]::WriteAllText((Join-Path $DataDir 'node-path.txt'), $nodeCmd.Source + "`r`n", [Text.Encoding]::Default)

# ---------- 6. arranque automático ----------
$viaTask = $false
if ($NoAutostart) { Step 'Arranque automático: desactivado (-NoAutostart)'; Remove-Autostart }
else { Step 'Arranque automático al iniciar sesión'; $viaTask = Register-Autostart }

# ---------- 7. arrancar ahora ----------
Step 'Arrancando el servidor (oculto)'
$started = $false
if ($viaTask) { try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; $started = $true } catch { Say ('  Start-ScheduledTask falló (' + $_.Exception.Message.Trim() + '); se arranca directamente.') Yellow } }
if (-not $started) { Start-Process -FilePath 'wscript.exe' -ArgumentList ('//B //Nologo "' + $Vbs + '"') -WorkingDirectory $Repo -WindowStyle Hidden }
$meta = Wait-Dashboard 15
if (-not $meta) { Fail ('El servidor no respondió en 15 s. Revisa ' + (Join-Path $DataDir 'server.log') + ' o arráncalo a mano para ver el error:  node server.mjs') }
$url = 'http://localhost:' + $Port
try { Start-Process $url } catch {}

# ---------- 8. resumen ----------
$count = 0
# En PowerShell 5.1 Invoke-RestMethod emite el array JSON como UN objeto: @(...) directo daría 1. Se asigna primero.
try { $itemsRes = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/items') -TimeoutSec 5; $count = @($itemsRes).Count } catch {}
$syncText = 'sin vault configurado'
if ($meta.vault -and $meta.vault.configured) {
  if (-not $meta.vault.exists) { $syncText = 'la carpeta del vault no existe ahora mismo (se reintenta cada ' + $meta.vault.intervalMinutes + ' min)' }
  elseif ($meta.vault.lastSync -and $meta.vault.lastSync.ok) { $syncText = 'sincronizado: ' + $meta.vault.lastSync.created + ' nuevos, ' + $meta.vault.lastSync.updated + ' actualizados (' + $meta.vault.lastSync.total + ' notas); cada ' + $meta.vault.intervalMinutes + ' min y al detectar cambios' }
  elseif ($meta.vault.lastSync) { $syncText = 'error al sincronizar: ' + $meta.vault.lastSync.error }
  else { $syncText = 'sincronizando...' }
}
Say ''
Say '=== Listo ===' Green
Say ('  Tablero:      ' + $url + '  (versión ' + $meta.version + ')')
Say ('  Elementos:    ' + $count)
if ($vaultPath) { Say ('  Vault:        ' + $vaultPath) } else { Say '  Vault:        (no configurado)' }
Say ('  Sincroniza:   ' + $syncText)
Say ('  Arranque:     ' + $script:Autostart)
Say ('  Registro:     ' + (Join-Path $DataDir 'server.log'))
Say ''
Say 'Puedes cerrar esta ventana: el servidor sigue corriendo oculto. Para actualizar o reparar, corre este mismo comando.'
Say 'Para quitar el arranque automático: powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall'
exit 0
