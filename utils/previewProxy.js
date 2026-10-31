import { createHash } from 'node:crypto'
import { sanitizeOpts, withUserAgent } from './channelOpts.js'
import { register, lookup, fetchNested, toProxyManifest, pipeUpstream, probeUpstream } from './hlsProxy.js'
import { rewriteManifest } from './appUtils.js'

// Only saved, enabled subscription sources can opt in. No arbitrary URL/header API.
export function previewSource(channel, sources) {
  return sources.find(source => source.enabled !== false && source.mode === 'subscription'
    && source.previewProxy === true && channel.sourceIds?.includes(`ext:${source.id}`))
}

export function previewPath(channel, sources) {
  const source = previewSource(channel, sources)
  if (!source || !/^https?:\/\//i.test(channel.url || '')) throw new Error('该频道未启用网页预览代理')
  const opts = sanitizeOpts(withUserAgent(channel.opts, source.userAgent, channel.url))
  const headers = {}
  const names = { 'http-user-agent': 'User-Agent', 'http-referrer': 'Referer', 'http-origin': 'Origin' }
  for (const opt of opts) {
    const at = opt.indexOf('=')
    const name = names[opt.slice(0, at)]
    if (name && !Object.hasOwn(headers, name)) headers[name] = opt.slice(at + 1)
  }
  // Separate channels/header configurations must never overwrite each other's registry entries.
  const pid = 'preview:' + createHash('sha256').update(JSON.stringify([channel.url, headers])).digest('hex').slice(0, 24)
  // Function form preserves the configured UA across redirects and nested requests.
  const key = register(channel.url, pid, undefined, () => ({ ...headers }))
  const ext = /\.(flv|mp4|mp3|aac)(?:[?#]|$)/i.exec(channel.url)?.[1].toLowerCase() || 'm3u8'
  return `${key}.${ext}`
}

export async function servePreview(req, res, key, ext) {
  const target = lookup(key)
  if (!target?.pid?.startsWith('preview:')) {
    res.writeHead(404); res.end('预览地址已过期，请重新打开频道'); return
  }
  if (ext === 'm3u8') {
    const nested = await fetchNested(target.url, target.upstreamHeaders)
    if (!nested) { res.writeHead(502); res.end('预览清单获取失败，请检查源地址和请求头'); return }
    const body = Buffer.from(toProxyManifest(rewriteManifest(nested.text, nested.finalUrl), target.pid, undefined, target.upstreamHeaders))
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'Content-Length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  } else if (req.method === 'HEAD') {
    await probeUpstream(target.url, req, res, undefined, target.upstreamHeaders)
  } else {
    await pipeUpstream(target.url, req, res, undefined, target.upstreamHeaders)
  }
}
