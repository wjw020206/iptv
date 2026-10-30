// 部分播放器支持的扩展格式：一条 EXTINF 后连续写多条地址。
// 显式开启的配置档订阅及 COS 导出共用；保留各来源的内部频道身份。
import { renderOpts, omitPlayerOnlyOpts } from './channelOpts.js'

function lineKey(name, directives) {
  return JSON.stringify([String(name).trim().normalize('NFKC').toLowerCase(), directives])
}

/** 后台合并视图保留每条来源记录，编辑操作仍按原始频道身份执行。 */
export function mergeChannelGroups(groups) {
  const output = groups.map(group => ({ ...group, channels: [] }))
  const byName = new Map()
  groups.forEach((group, index) => {
    for (const channel of group.channels) {
      const directives = omitPlayerOnlyOpts(`#EXTINF:-1,channel\n${renderOpts(channel.opts)}${channel.url}\n`).split('\n').filter(line => line.startsWith('#EXTVLCOPT:'))
      const key = lineKey(channel.name, directives)
      let merged = byName.get(key)
      if (!merged) {
        merged = { ...channel, lines: [] }
        byName.set(key, merged)
        output[index].channels.push(merged)
      }
      merged.lines.push({ ...channel, groupName: group.name })
      merged.lineCount = new Set(merged.lines.map(line => line.url)).size
    }
  })
  return output
}
function separator(line) {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ',' && !quoted) return i
  }
  return -1
}

function catchupAttrs(line) {
  const result = {}
  for (const [, key, value] of line.matchAll(/\s(catchup(?:-days|-source)?)="([^"]*)"/g)) result[key] = value
  return result
}

export function mergePlaylistLines(content) {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const prefix = [], entries = []
  let current
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      current = { header: line, lines: [] }
      entries.push(current)
    } else if (current) {
      if (line.trim()) current.lines.push(line.trim())
    } else if (line.trim()) prefix.push(line)
  }
  const defaults = catchupAttrs(prefix.find(line => line.startsWith('#EXTM3U')) || '')
  const output = [], byName = new Map()
  for (const entry of entries) {
    const comma = separator(entry.header)
    const name = comma < 0 ? '' : entry.header.slice(comma + 1).trim()
    if (!name) throw new Error('多线路合并失败：频道缺少显示名称')
    const directives = entry.lines.filter(line => line.startsWith('#'))
    const urls = entry.lines.filter(line => !line.startsWith('#'))
    if (!urls.length) throw new Error('多线路合并失败：频道缺少播放地址')
    // 不把不同 UA/Referer 等配置共用到另一路：这类条目保留独立输出。
    const key = lineKey(name, directives)
    const attrs = { ...defaults, ...catchupAttrs(entry.header.slice(0, comma)) }
    const catchup = JSON.stringify(['catchup', 'catchup-days', 'catchup-source'].map(key => attrs[key] || ''))
    let merged = byName.get(key)
    if (!merged) {
      merged = { header: entry.header, directives, urls: new Set(), catchup }
      byName.set(key, merged)
      output.push(merged)
    } else if (merged.catchup !== catchup) {
      // 多条线路不能分别声明回看模板；避免把咪咕回看模板套在央视频上。
      const boundary = separator(merged.header)
      const attrs = merged.header.slice(0, boundary).replace(/\s+catchup(?:-days|-source)?="[^"]*"/g, '')
      merged.header = `${attrs} catchup="none"${merged.header.slice(boundary)}`
    }
    for (const url of urls) merged.urls.add(url)
  }
  return [...prefix, ...output.flatMap(entry => [entry.header, ...entry.directives, ...entry.urls])].join('\n') + '\n'
}
