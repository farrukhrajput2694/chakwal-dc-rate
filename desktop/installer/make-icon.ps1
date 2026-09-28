# Generate the app icon: make-icon.ps1
#
#   powershell -ExecutionPolicy Bypass -File desktop\installer\make-icon.ps1
#
# Produces desktop\installer\chakwal.ico at 16/32/48/64/128/256 px.
#
# Why a script and not a checked-in binary: the icon has to stay in step with
# the app's own colour, and a script that derives it from the stylesheet's
# background colour can be re-run and re-checked, which a .ico cannot.
#
# Why a hand-written ICO writer: System.Drawing has no multi-resolution save.
# Icon.FromHandle only ever holds one size, and a 16 px app icon is not a
# finished product. So the ICO container is assembled by hand, which is also the
# only way to guarantee a BMP (not PNG) payload for the large sizes -- PNG
# inside an ICO is fine on Vista and later but is a needless risk on the older
# machines this build also has to serve.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$OutDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutFile = Join-Path $OutDir 'chakwal.ico'

# The app's own background colour, from desktop\web\styles.css.
$Bg = [System.Drawing.Color]::FromArgb(255, 15, 23, 42)      # #0f172a
$Fg = [System.Drawing.Color]::FromArgb(255, 248, 250, 252)   # #f8fafc
$Accent = [System.Drawing.Color]::FromArgb(255, 56, 189, 248) # #38bdf8

function Add-RoundedRect {
    param($Path, [double]$X, [double]$Y, [double]$W, [double]$H, [double]$R)
    $d = $R * 2
    $Path.AddArc($X, $Y, $d, $d, 180, 90)
    $Path.AddArc(($X + $W - $d), $Y, $d, $d, 270, 90)
    $Path.AddArc(($X + $W - $d), ($Y + $H - $d), $d, $d, 0, 90)
    $Path.AddArc($X, ($Y + $H - $d), $d, $d, 90, 90)
    $Path.CloseFigure()
}

function New-IconImage {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [Math]::Max(1, [int]($Size * 0.04))
    $side = $Size - (2 * $pad)
    $radius = [Math]::Max(2, [int]($Size * 0.2))

    $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect $shape $pad $pad $side $side $radius

    $fill = New-Object System.Drawing.SolidBrush $Bg
    $g.FillPath($fill, $shape)

    # A hairline in the accent colour so the icon reads on a dark desktop too.
    if ($Size -ge 32) {
        $pen = New-Object System.Drawing.Pen $Accent, ([Math]::Max(1, $Size * 0.045))
        $g.DrawPath($pen, $shape)
        $pen.Dispose()
    }

    # "Rs" rather than a rupee glyph: U+20A8 is missing from many of the fonts
    # that ship on the older Windows versions this icon has to survive on, and
    # a missing glyph would render as a blank box.
    $text = 'Rs'
    $fontSize = [float]$Size * 0.46
    $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush $Fg
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString($text, $font, $brush, (New-Object System.Drawing.RectangleF 0, 0, $Size, $Size), $sf)
    $sf.Dispose(); $brush.Dispose(); $font.Dispose()

    $fill.Dispose(); $shape.Dispose(); $g.Dispose()
    return $bmp
}

function Get-BgraBytes {
    param($Bitmap)
    $w = $Bitmap.Width; $h = $Bitmap.Height
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $buf = New-Object byte[] ($w * $h * 4)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
    } finally {
        $Bitmap.UnlockBits($data)
    }
    # DIBs in an ICO are stored bottom-up.
    $flipped = New-Object byte[] $buf.Length
    $stride = $w * 4
    for ($y = 0; $y -lt $h; $y++) {
        [Array]::Copy($buf, ($h - 1 - $y) * $stride, $flipped, $y * $stride, $stride)
    }
    return $flipped
}

$sizes = @(16, 32, 48, 64, 128, 256)
$images = @()

foreach ($s in $sizes) {
    $bmp = New-IconImage $s
    $xor = Get-BgraBytes $bmp
    $bmp.Dispose()

    $and = New-Object byte[] ([int]([Math]::Ceiling($s / 32.0) * 4) * $s)
    [Array]::Clear($and, 0, $and.Length)

    # An icon's embedded DIB starts at biSize. There is NO BITMAPFILEHEADER:
    # no "BM", no file size, no reserved words. The ICONDIRENTRY already
    # carries the length and the offset, so a file header here is not merely
    # redundant -- it shifts every field by 14 bytes and GDI reads the 'BM' as
    # biSize and rejects the whole icon.
    $header = New-Object byte[] 40
    [Array]::Copy([BitConverter]::GetBytes([int]40), 0, $header, 0, 4)                    # biSize
    [Array]::Copy([BitConverter]::GetBytes([int]$s), 0, $header, 4, 4)                     # biWidth
    [Array]::Copy([BitConverter]::GetBytes([int]($s * 2)), 0, $header, 8, 4)               # biHeight: XOR + AND
    [Array]::Copy([BitConverter]::GetBytes([int]1), 0, $header, 12, 2)                    # biPlanes
    [Array]::Copy([BitConverter]::GetBytes([int]32), 0, $header, 14, 2)                   # biBitCount
    [Array]::Copy([BitConverter]::GetBytes([int]0), 0, $header, 16, 4)                    # BI_RGB
    [Array]::Copy([BitConverter]::GetBytes([int]($xor.Length + $and.Length)), 0, $header, 20, 4)

    $payload = New-Object byte[] ($header.Length + $xor.Length + $and.Length)
    [Array]::Copy($header, 0, $payload, 0, $header.Length)
    [Array]::Copy($xor, 0, $payload, $header.Length, $xor.Length)
    [Array]::Copy($and, 0, $payload, $header.Length + $xor.Length, $and.Length)

    $images += , @{ Size = $s; Data = $payload }
    Write-Host ("  {0,3}px  {1,7} bytes" -f $s, $payload.Length)
}

$dir = New-Object byte[] 6
[Array]::Copy([BitConverter]::GetBytes([int]0), 0, $dir, 0, 2)  # reserved
[Array]::Copy([BitConverter]::GetBytes([int]1), 0, $dir, 2, 2)  # type: icon
[Array]::Copy([BitConverter]::GetBytes([int]$images.Count), 0, $dir, 4, 2)

$ms = New-Object System.IO.MemoryStream
$ms.Write($dir, 0, $dir.Length)
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
    $entry = New-Object byte[] 16
    $d = [int]$img.Size
    if ($d -ge 256) { $d = 0 }   # 256 is encoded as 0 in the ICONDIRENTRY
    $entry[0] = [byte]$d
    $entry[1] = [byte]$d
    $entry[2] = 0; $entry[3] = 0
    [Array]::Copy([BitConverter]::GetBytes([int]1), 0, $entry, 4, 2)   # colour planes
    [Array]::Copy([BitConverter]::GetBytes([int]32), 0, $entry, 6, 2)  # bits per pixel
    [Array]::Copy([BitConverter]::GetBytes([int]$img.Data.Length), 0, $entry, 8, 4)
    [Array]::Copy([BitConverter]::GetBytes([int]$offset), 0, $entry, 12, 4)
    $ms.Write($entry, 0, 16)
    $offset += $img.Data.Length
}
foreach ($img in $images) { $ms.Write($img.Data, 0, $img.Data.Length) }

[System.IO.File]::WriteAllBytes($OutFile, $ms.ToArray())
$ms.Dispose()
Write-Host ""
Write-Host ("  wrote {0} ({1} bytes, {2} sizes)" -f $OutFile, (Get-Item $OutFile).Length, $images.Count)
