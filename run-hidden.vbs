' run-hidden.vbs - arranca el servidor del Tablero SIN ventana y lo vuelve a levantar si se cae.
' Lo usa la tarea programada "Tablero" (setup.ps1) y el acceso directo de la carpeta Inicio.
' Uso manual: wscript //B //Nologo run-hidden.vbs    (desde la carpeta del repo o con la ruta completa)
' - Carpeta de trabajo = la carpeta de este archivo (el repo), asi que no importa desde donde se lance.
' - node.exe: ruta guardada por setup.ps1 en data\node-path.txt; si no existe, "node" del PATH.
' - Si node termina con codigo 0 (por ejemplo "el tablero ya esta abierto en otro proceso") no se reinicia.
' - Si termina con error se espera 5 s y se reintenta; tras 20 caidas seguidas en menos de un minuto se rinde.
Option Explicit
Dim sh, fso, dir, nodeExe, code, fails, started, f
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
nodeExe = "node"
If fso.FileExists(dir & "\data\node-path.txt") Then
  Set f = fso.OpenTextFile(dir & "\data\node-path.txt", 1)
  If Not f.AtEndOfStream Then nodeExe = Trim(f.ReadLine)
  f.Close
  If nodeExe = "" Or Not fso.FileExists(nodeExe) Then nodeExe = "node"
End If
fails = 0
Do
  started = Timer
  code = sh.Run("""" & nodeExe & """ server.mjs", 0, True)
  If code = 0 Then Exit Do
  If Timer - started > 60 Or Timer - started < 0 Then fails = 0
  fails = fails + 1
  If fails > 20 Then Exit Do
  WScript.Sleep 5000
Loop
