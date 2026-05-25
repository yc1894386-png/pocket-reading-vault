param(
  [int]$Port = 4173
)

$ErrorActionPreference = "Stop"
$Root = Join-Path $PSScriptRoot "public"
$Prefix = "http://localhost:$Port/"

function Send-Text($Context, [int]$Status, [string]$Body, [string]$ContentType) {
  $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $Context.Response.StatusCode = $Status
  $Context.Response.ContentType = $ContentType
  $Context.Response.ContentLength64 = $Bytes.Length
  $Context.Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
  $Context.Response.OutputStream.Close()
}

function Decode-Entities([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $WithoutTags = $Value -replace "<[^>]*>", " "
  $Collapsed = ($WithoutTags -replace "\s+", " ").Trim()
  $Decoded = $Collapsed
  $Decoded = $Decoded -replace "&amp;", "&"
  $Decoded = $Decoded -replace "&lt;", "<"
  $Decoded = $Decoded -replace "&gt;", ">"
  $Decoded = $Decoded -replace "&quot;", '"'
  $Decoded = $Decoded -replace "&#39;", "'"
  $Decoded = $Decoded -replace "&apos;", "'"
  $Decoded = $Decoded -replace "&nbsp;", " "
  return $Decoded
}

function First-Match([string]$Html, [string]$Pattern) {
  $Match = [regex]::Match($Html, $Pattern, "IgnoreCase, Singleline")
  if ($Match.Success) { return $Match.Groups[1].Value }
  return ""
}

function All-Link-Text([string]$Html) {
  $Items = @()
  foreach ($Match in [regex]::Matches($Html, "<a[^>]*>([\s\S]*?)</a>", "IgnoreCase")) {
    $Text = Decode-Entities $Match.Groups[1].Value
    if ($Text) { $Items += $Text }
  }
  return $Items
}

function Get-QueryValue([string]$Query, [string]$Name) {
  $Trimmed = $Query.TrimStart("?")
  foreach ($Pair in $Trimmed -split "&") {
    if (-not $Pair) { continue }
    $Parts = $Pair -split "=", 2
    $Key = [System.Net.WebUtility]::UrlDecode($Parts[0])
    if ($Key -eq $Name) {
      if ($Parts.Length -gt 1) { return [System.Net.WebUtility]::UrlDecode($Parts[1]) }
      return ""
    }
  }
  return $null
}

function Set-QueryValue([string]$Query, [string]$Name, [string]$Value) {
  $Pairs = @()
  $Seen = $false
  foreach ($Pair in $Query.TrimStart("?") -split "&") {
    if (-not $Pair) { continue }
    $Parts = $Pair -split "=", 2
    $Key = [System.Net.WebUtility]::UrlDecode($Parts[0])
    if ($Key -eq $Name) {
      $Pairs += "$([System.Net.WebUtility]::UrlEncode($Name))=$([System.Net.WebUtility]::UrlEncode($Value))"
      $Seen = $true
    } else {
      $Pairs += $Pair
    }
  }
  if (-not $Seen) {
    $Pairs += "$([System.Net.WebUtility]::UrlEncode($Name))=$([System.Net.WebUtility]::UrlEncode($Value))"
  }
  return ($Pairs -join "&")
}

function ConvertTo-AbsoluteUrl([string]$Url, [string]$BaseUrl) {
  if ([string]::IsNullOrWhiteSpace($Url)) { return $Url }
  if ($Url -match "^(https?:|data:|blob:)") { return $Url }
  if ($Url.StartsWith("//")) { return "https:$Url" }
  try {
    return ([System.Uri]::new([System.Uri]::new($BaseUrl), $Url)).AbsoluteUri
  } catch {
    return $Url
  }
}

function Get-MimeTypeFromUrl([string]$Url, [string]$Fallback) {
  if ($Fallback) { return ($Fallback -split ";")[0] }
  $Path = ([System.Uri]$Url).AbsolutePath
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".png" { return "image/png" }
    ".gif" { return "image/gif" }
    ".webp" { return "image/webp" }
    ".svg" { return "image/svg+xml" }
    default { return "application/octet-stream" }
  }
}

function ConvertTo-EmbeddedImages([string]$Content) {
  return [regex]::Replace($Content, '(<img\b[^>]*\bsrc=")([^"]+)(")', {
    param($Match)
    $Url = $Match.Groups[2].Value
    if ($Url -match "^data:") { return $Match.Value }
    try {
      $Client = [System.Net.WebClient]::new()
      $Client.Headers.Set("User-Agent", "Mozilla/5.0 AO3 Pocket Library")
      $Bytes = $Client.DownloadData($Url)
      if ($Bytes.Length -gt 3145728) { return $Match.Value }
      $Mime = Get-MimeTypeFromUrl $Url $Client.ResponseHeaders["Content-Type"]
      $DataUrl = "data:$Mime;base64,$([Convert]::ToBase64String($Bytes))"
      return "$($Match.Groups[1].Value)$DataUrl$($Match.Groups[3].Value)"
    } catch {
      return $Match.Value
    }
  }, "IgnoreCase")
}

function ConvertTo-CleanWorkHtml([string]$Html, [string]$SourceUrl) {
  $Start = [regex]::Match($Html, "<div[^>]+id=`"chapters`"[^>]*>", "IgnoreCase")
  if ($Start.Success) {
    $ContentStart = $Start.Index
    $Tail = $Html.Substring($ContentStart)
    $End = [regex]::Match($Tail, "<div[^>]+id=`"(afterword|feedback|kudos|comments_placeholder)`"[^>]*>", "IgnoreCase")
    if ($End.Success) {
      $Content = $Tail.Substring(0, $End.Index)
    } else {
      $Content = $Tail
    }
  } else {
    $Content = First-Match $Html "<div[^>]+id=`"chapters`"[^>]*>([\s\S]*?)</div>"
  }
  $Content = $Content -replace "<script[\s\S]*?</script>", ""
  $Content = $Content -replace "<style[\s\S]*?</style>", ""
  $Content = $Content -replace '\son\w+="[\s\S]*?"', ""
  $Content = $Content -replace 'href="javascript:[\s\S]*?"', ""
  $Content = [regex]::Replace($Content, '(src|href)="([^"]+)"', {
    param($Match)
    $Name = $Match.Groups[1].Value
    $Url = ConvertTo-AbsoluteUrl $Match.Groups[2].Value $SourceUrl
    return "$Name=`"$Url`""
  }, "IgnoreCase")
  if ($Content.Length -lt 1500000) {
    $Content = ConvertTo-EmbeddedImages $Content
  }
  return $Content
}

function ConvertFrom-Ao3Html([string]$Html, [string]$SourceUrl) {
  $Title = Decode-Entities (First-Match $Html "<h2[^>]+class=`"[^`"]*title[^`"]*heading[^`"]*`"[^>]*>([\s\S]*?)</h2>")
  if (-not $Title) {
    $Title = (Decode-Entities (First-Match $Html "<title[^>]*>([\s\S]*?)</title>")) -replace "\s*\|\s*Archive of Our Own.*$", ""
  }
  if (-not $Title) { $Title = "Untitled work" }

  $Author = Decode-Entities (First-Match $Html "<h3[^>]+class=`"[^`"]*byline[^`"]*heading[^`"]*`"[^>]*>([\s\S]*?)</h3>")
  $Summary = First-Match $Html "<blockquote[^>]+class=`"[^`"]*userstuff[^`"]*summary[^`"]*`"[^>]*>([\s\S]*?)</blockquote>"
  if (-not $Summary) {
    $Summary = First-Match $Html "<div[^>]+class=`"[^`"]*summary[^`"]*`"[^>]*>[\s\S]*?<blockquote[^>]*>([\s\S]*?)</blockquote>"
  }
  $Content = ConvertTo-CleanWorkHtml $Html $SourceUrl
  if (-not $Content -or $Content.Length -lt 80) {
    throw "No readable work body was found. Please check that this is a public AO3 work page."
  }

  $Rating = Decode-Entities (First-Match $Html "<dd[^>]+class=`"[^`"]*rating[^`"]*tags[^`"]*`"[^>]*>([\s\S]*?)</dd>")
  $CategoryBlock = First-Match $Html "<dd[^>]+class=`"[^`"]*category[^`"]*tags[^`"]*`"[^>]*>([\s\S]*?)</dd>"
  $FandomBlock = First-Match $Html "<dd[^>]+class=`"[^`"]*fandom[^`"]*tags[^`"]*`"[^>]*>([\s\S]*?)</dd>"
  $WarningBlock = First-Match $Html "<dd[^>]+class=`"[^`"]*warning[^`"]*tags[^`"]*`"[^>]*>([\s\S]*?)</dd>"
  $RelationshipBlock = First-Match $Html "<dd[^>]+class=`"[^`"]*relationship[^`"]*tags[^`"]*`"[^>]*>([\s\S]*?)</dd>"
  $CharacterBlock = First-Match $Html "<dd[^>]+class=`"[^`"]*character[^`"]*tags[^`"]*`"[^>]*>([\s\S]*?)</dd>"
  $FreeformBlock = First-Match $Html "<dd[^>]+class=`"[^`"]*freeform[^`"]*tags[^`"]*`"[^>]*>([\s\S]*?)</dd>"

  return @{
    title = $Title
    author = $Author
    sourceUrl = $SourceUrl
    importedAt = (Get-Date).ToUniversalTime().ToString("o")
    summaryHtml = $Summary
    contentHtml = $Content
    metadata = @{
      rating = $Rating
      categories = @(All-Link-Text $CategoryBlock)
      fandoms = @(All-Link-Text $FandomBlock)
      warnings = @(All-Link-Text $WarningBlock)
      relationships = @(All-Link-Text $RelationshipBlock)
      characters = @(All-Link-Text $CharacterBlock)
      freeforms = @(All-Link-Text $FreeformBlock)
      words = Decode-Entities (First-Match $Html "<dd[^>]+class=`"[^`"]*words[^`"]*`"[^>]*>([\s\S]*?)</dd>")
      chapters = Decode-Entities (First-Match $Html "<dd[^>]+class=`"[^`"]*chapters[^`"]*`"[^>]*>([\s\S]*?)</dd>")
      status = Decode-Entities (First-Match $Html "<dd[^>]+class=`"[^`"]*status[^`"]*`"[^>]*>([\s\S]*?)</dd>")
      language = Decode-Entities (First-Match $Html "<dd[^>]+class=`"[^`"]*language[^`"]*`"[^>]*>([\s\S]*?)</dd>")
    }
  }
}

function Import-Ao3Work([string]$Source) {
  $Uri = [System.UriBuilder]::new($Source)
  if ($Uri.Host -notmatch "(^|\.)archiveofourown\.org$") {
    throw "Only archiveofourown.org work links are supported."
  }
  $Uri.Path = $Uri.Path -replace "/chapters/\d+/?$", ""

  $Query = Set-QueryValue $Uri.Query "view_adult" "true"
  $Query = Set-QueryValue $Query "view_full_work" "true"
  $Uri.Query = $Query
  $FinalUrl = $Uri.Uri.AbsoluteUri

  $Headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AO3 Pocket Library"
    "Accept" = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    "Accept-Language" = "zh-CN,zh;q=0.9,en;q=0.8"
  }
  $LastError = $null
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      $Response = Invoke-WebRequest -Uri $FinalUrl -UseBasicParsing -Headers $Headers -TimeoutSec 45
      return ConvertFrom-Ao3Html $Response.Content $FinalUrl
    } catch {
      $LastError = $_
      if ($_.Exception.Message -match "\(525\)") {
        Start-Sleep -Seconds (2 * $Attempt)
        continue
      }
      throw
    }
  }
  if ($LastError.Exception.Message -match "\(525\)") {
    throw "AO3/Cloudflare returned 525, which means AO3 did not complete the secure connection. Please try again later, or open AO3 in your browser, download the work as HTML, then use Import HTML File."
  }
  throw $LastError
}

function Send-RawResponse($Stream, [int]$Status, [string]$ContentType, [byte[]]$Bytes) {
  $Reason = switch ($Status) {
    200 { "OK" }
    400 { "Bad Request" }
    403 { "Forbidden" }
    422 { "Unprocessable Entity" }
    default { "Internal Server Error" }
  }
  $Header = "HTTP/1.1 $Status $Reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Bytes.Length)`r`nConnection: close`r`n`r`n"
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  $Stream.Write($Bytes, 0, $Bytes.Length)
}

function Send-RawText($Stream, [int]$Status, [string]$Body, [string]$ContentType) {
  Send-RawResponse $Stream $Status $ContentType ([System.Text.Encoding]::UTF8.GetBytes($Body))
}

$Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$Listener.Start()
Write-Host "AO3 Offline Shelf is running at $Prefix"

try {
  while ($true) {
    $Client = $Listener.AcceptTcpClient()
    try {
      $Stream = $Client.GetStream()
      $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
      $RequestLine = $Reader.ReadLine()
      if (-not $RequestLine) {
        Send-RawText $Stream 400 "Bad Request" "text/plain; charset=utf-8"
        continue
      }
      $Parts = $RequestLine -split " "
      $Target = $Parts[1]
      $TargetParts = $Target -split "\?", 2
      $Path = [System.Net.WebUtility]::UrlDecode($TargetParts[0])
      $QueryText = if ($TargetParts.Length -gt 1) { $TargetParts[1] } else { "" }

      if ($Path -eq "/api/import") {
        $Source = Get-QueryValue $QueryText "url"
        if (-not $Source) {
          Send-RawText $Stream 400 '{"error":"Missing AO3 URL."}' "application/json; charset=utf-8"
          continue
        }
        try {
          $Payload = Import-Ao3Work $Source
          Send-RawText $Stream 200 ($Payload | ConvertTo-Json -Depth 8) "application/json; charset=utf-8"
        } catch {
          Send-RawText $Stream 422 (@{ error = $_.Exception.Message } | ConvertTo-Json) "application/json; charset=utf-8"
        }
        continue
      }

      if ($Path -eq "/") { $Path = "/index.html" }
      $Relative = $Path.TrimStart("/") -replace "/", [System.IO.Path]::DirectorySeparatorChar
      $File = [System.IO.Path]::GetFullPath((Join-Path $Root $Relative))
      if (-not $File.StartsWith([System.IO.Path]::GetFullPath($Root))) {
        Send-RawText $Stream 403 "Forbidden" "text/plain; charset=utf-8"
        continue
      }
      if (-not (Test-Path $File -PathType Leaf)) {
        $File = Join-Path $Root "index.html"
      }
      $Ext = [System.IO.Path]::GetExtension($File)
      $Type = switch ($Ext) {
        ".html" { "text/html; charset=utf-8" }
        ".css" { "text/css; charset=utf-8" }
        ".js" { "application/javascript; charset=utf-8" }
        default { "application/octet-stream" }
      }
      Send-RawResponse $Stream 200 $Type ([System.IO.File]::ReadAllBytes($File))
    } catch {
      if ($Stream) {
        Send-RawText $Stream 500 "Internal Server Error" "text/plain; charset=utf-8"
      }
    } finally {
      $Client.Close()
    }
  }
} finally {
  $Listener.Stop()
}
