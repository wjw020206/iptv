import assert from 'node:assert/strict'
import { mergePlaylistLines, mergeChannelGroups } from '../utils/multiLinePlaylist.js'

const header = '#EXTM3U x-tvg-url="https://tv.example/epg.xml" catchup="append" catchup-source="?begin={utc}"'
const input = `${header}
#EXTINF:-1 tvg-id="CCTV1综合" tvg-name="CCTV1综合" tvg-logo="https://img.example/a,b.png" group-title="央视",CCTV1综合
http://tv.example/pass/608807420
#EXTINF:-1 tvg-id="CCTV2财经" group-title="央视",CCTV2财经
https://cdn.example/cctv2.m3u8
#EXTINF:-1 tvg-id="CCTV1综合" catchup="none" group-title="央视频",CCTV1综合
http://tv.example/pass/relay/ysp-cctv1.m3u8
#EXTINF:-1 group-title="备用",CCTV1综合
http://tv.example/pass/608807420
#EXTINF:-1 tvg-id="CCTV16" group-title="央视",CCTV16
https://cdn.example/16.m3u8
#EXTINF:-1 tvg-id="CCTV16" group-title="央视频",CCTV16 4K
https://cdn.example/164k.m3u8
`
const output = mergePlaylistLines(input)
assert.equal((output.match(/^#EXTINF:/gm) || []).length, 4)
assert.ok(output.startsWith(header + '\n'))
assert.ok(output.includes('tvg-logo="https://img.example/a,b.png" group-title="央视" catchup="none",CCTV1综合\nhttp://tv.example/pass/608807420\nhttp://tv.example/pass/relay/ysp-cctv1.m3u8\n'))
assert.equal((output.match(/608807420/g) || []).length, 1)
assert.ok(output.indexOf('CCTV1综合') < output.indexOf('CCTV2财经'))
assert.ok(output.includes(',CCTV16\n'))
assert.ok(output.includes(',CCTV16 4K\n'))
assert.equal(mergePlaylistLines(output), output, '已合并格式重复转换应保持不变')

const opts = `${header}
#EXTINF:-1 group-title="体育",测试台
#EXTVLCOPT:http-referrer=https://a.example/
https://cdn.example/a.m3u8
#EXTINF:-1 group-title="备用",测试台
#EXTVLCOPT:http-referrer=https://b.example/
https://cdn.example/b.m3u8
#EXTINF:-1 group-title="备用",测试台
#EXTVLCOPT:http-referrer=https://a.example/
https://cdn.example/c.m3u8
`
const withOpts = mergePlaylistLines(opts)
assert.equal((withOpts.match(/^#EXTINF:/gm) || []).length, 2)
assert.ok(withOpts.includes('https://a.example/\nhttps://cdn.example/a.m3u8\nhttps://cdn.example/c.m3u8'))
assert.ok(withOpts.includes('https://b.example/\nhttps://cdn.example/b.m3u8'))
assert.throws(() => mergePlaylistLines('#EXTM3U\n#EXTINF:-1,测试\n'), /缺少播放地址/)
assert.throws(() => mergePlaylistLines('#EXTM3U\n#EXTINF:-1,\nhttps://a.example/live\n'), /缺少显示名称/)
console.log('多线路合并测试通过：跨组同名、顺序、去重、4K 区分、逗号属性、请求头隔离、回看差异和重复转换')

const groups = [
  { name: '央视', channels: [{ id: 'migu1', name: 'CCTV1综合', url: 'https://cdn/one', originalGroup: '央视' }, { id: '16', name: 'CCTV16', url: 'https://cdn/16' }] },
  { name: '央视频', channels: [{ id: 'ysp1', name: 'CCTV1综合', url: 'https://cdn/two', originalGroup: '央视频' }, { id: '4k', name: 'CCTV16 4K', url: 'https://cdn/4k' }] },
]
const before = JSON.stringify(groups)
const merged = mergeChannelGroups(groups)
assert.equal(merged[0].channels[0].lineCount, 2)
assert.deepEqual(merged[0].channels[0].lines.map(line => line.id), ['migu1', 'ysp1'])
assert.equal(merged[0].channels[0].lines[1].groupName, '央视频')
assert.equal(merged[1].channels.length, 1)
assert.equal(merged[1].channels[0].name, 'CCTV16 4K')
assert.equal(JSON.stringify(groups), before, '合并视图不得修改原始编辑数据')
const isolated = mergeChannelGroups([{ name: 'test', channels: [
  { id: 'a', name: 'A', url: 'https://cdn/a', opts: ['http-referrer=https://one'] },
  { id: 'b', name: 'A', url: 'https://cdn/b', opts: ['http-referrer=https://two'] },
] }])
assert.equal(isolated[0].channels.length, 2)
