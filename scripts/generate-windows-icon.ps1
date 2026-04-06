param(
  [string]$Source = "..\aura-extension\assets\icon4.png",
  [string]$BuildDir = "build"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Source))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $BuildDir))
$pngOutputPath = Join-Path $outputRoot "icon.png"
$icoOutputPath = Join-Path $outputRoot "icon.ico"
$sizes = @(16, 24, 32, 48, 64, 128, 256)

if (-not (Test-Path $sourcePath)) {
  throw "Source image not found: $sourcePath"
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

try {
  Copy-Item $sourcePath $pngOutputPath -Force

  $frames = foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
      } finally {
        $graphics.Dispose()
      }

      $memory = New-Object System.IO.MemoryStream
      try {
        $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        [PSCustomObject]@{
          Size = $size
          Bytes = $memory.ToArray()
        }
      } finally {
        $memory.Dispose()
      }
    } finally {
      $bitmap.Dispose()
    }
  }

  $fileStream = [System.IO.File]::Open($icoOutputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    $writer = New-Object System.IO.BinaryWriter($fileStream)
    try {
      $writer.Write([UInt16]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]$frames.Count)

      $offset = 6 + (16 * $frames.Count)
      foreach ($frame in $frames) {
        $dimension = if ($frame.Size -ge 256) { 0 } else { [byte]$frame.Size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$frame.Bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $frame.Bytes.Length
      }

      foreach ($frame in $frames) {
        $writer.Write($frame.Bytes)
      }
    } finally {
      $writer.Dispose()
    }
  } finally {
    $fileStream.Dispose()
  }

  Write-Host "Generated icon assets:"
  Write-Host " - $pngOutputPath"
  Write-Host " - $icoOutputPath"
  Write-Host ("Sizes: " + ($sizes -join ", "))
} finally {
  $sourceImage.Dispose()
}
