// 知网检索 URL 构造（纯函数，不发起任何网络请求）
const KNS = 'https://kns.cnki.net/kns8s'

const FIELD_CODES = ['SU', 'TI', 'AB', 'KY', 'FT', 'AU']
const DB_CODES = ['CFLS', 'CJFD', 'CDFDL', 'CMFD', 'CIPD']

export function buildCnkiSearchUrl({ query, professional, field = 'SU', dbcode = 'CFLS' }) {
  if (!query && !professional) throw new Error('必须提供 query 或 professional 之一')
  if (query && professional) throw new Error('query 与 professional 只能提供一个')
  if (!DB_CODES.includes(dbcode)) throw new Error(`不支持的 dbcode: ${dbcode}（可选：${DB_CODES.join(', ')}）`)

  if (professional) {
    return {
      url: `${KNS}/AdvSearch?dbcode=${dbcode}`,
      mode: 'professional',
      expression: professional,
      guidance:
        '已生成知网专业检索页链接。打开后切换到"专业检索"，粘贴检索式执行。' +
        '检索式规范：字段代码 SU(主题)/TI(篇名)/AB(摘要)/KY(关键词)/FT(全文)/AU(作者)，' +
        "逻辑算符 AND/OR/NOT，精确匹配用单引号如 SU='合同无效'，检索范围用 SU='合同' * '解除' 的 * 表示同句、# 表示同段。",
    }
  }

  if (!FIELD_CODES.includes(field)) throw new Error(`不支持的 field: ${field}（可选：${FIELD_CODES.join(', ')}）`)
  return {
    url: `${KNS}/defaultresult/index?dbcode=${dbcode}&kw=${encodeURIComponent(query)}&korder=${field}`,
    mode: 'keyword',
    guidance:
      '已生成知网检索结果页链接，用浏览器打开即可（需在校园网或学校 VPN 环境下）。' +
      '法学文献综述建议：左侧"来源类别"勾选 CSSCI 与北大核心；先按"被引"排序摸清经典文献，再按"发表时间"补充近三年新文献。',
  }
}
