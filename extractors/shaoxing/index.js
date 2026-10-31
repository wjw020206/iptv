import { CHANNELS, SHENGZHOU_REF, claimsRef, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'shaoxing', name: '绍兴',
  description: '绍兴网三套电视直播及嵊州新闻综合；绍兴网频道自动发现并验证官网当前地址，嵊州通过服务器播放接口提供公开 HLS 源。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 3, outputGroupName: '浙江',
  channelHlsMode: 'relay', relayProxyCompatible: true,
  defaultRefreshMinutes: 1440, refreshConfigurable: false,
  refreshDescription: '固定四路目录；绍兴网三套每次播放重新发现官方源，嵊州新闻综合通过服务器播放接口取流，不提供节目单和回看。',
  configSchema: [],
  async fetch() {
    return {
      groups: [{ name: '浙江', dataList: [...CHANNELS.map(channel => ({
        name: channel.name, logo: channel.logo, deferredRef: channel.ref,
        opts: ['network-caching=3000'], catchup: 'none',
      })), {
        name: '嵊州新闻综合',
        // 嵊州新闻网首页及其天天快看节目入口未找到独立频道图，使用 logo-pack 内置台标。
        deferredRef: SHENGZHOU_REF,
        catchup: 'none',
      }] }],
      meta: { skipped: [], warnings: [] },
    }
  },
  claimsRef, resolve: resolveChannel, epg,
}
