import { describe, expect, it } from 'vitest'
import { buildTrendOption } from '../src/renderer/components/ConsumeBlocks'

describe('token 走势配置', () => {
  const hourly = [
    { model: 'gpt-5.1', points: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 100 : 0)) },
    { model: 'deepseek-chat', points: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 50 : 0)) },
    { model: '其他 3 个模型', points: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 20 : 0)) },
  ]

  it('今日走势按模型堆叠成柱状', () => {
    const option = buildTrendOption({ groups: [], dates: [], hourly, dark: false }) as {
      series: Array<{ name: string; type: string; stack?: string; data: number[] }>
      xAxis: { data: string[] }
      legend?: { type: string }
    }
    expect(option.series).toHaveLength(3)
    expect(option.series.map((series) => series.name)).toEqual(['gpt-5.1', 'deepseek-chat', '其他 3 个模型'])
    // 每个模型一条堆叠系列，横轴是 24 小时。
    expect(option.series.every((series) => series.type === 'bar' && series.stack === 'total')).toBe(true)
    expect(option.series[0].data).toHaveLength(24)
    expect(option.xAxis.data).toHaveLength(24)
    expect(option.legend?.type).toBe('scroll')
  })

  it('按日走势仍是按模型拆线', () => {
    const groups = [
      { model: 'gpt-5.1', points: [{ date: '2026-10-29', tokens: 10 }, { date: '2026-10-30', tokens: 20 }] },
      { model: 'deepseek-chat', points: [{ date: '2026-10-29', tokens: 5 }, { date: '2026-10-30', tokens: 8 }] },
    ]
    const option = buildTrendOption({ groups, dates: ['2026-10-29', '2026-10-30'], dark: false }) as {
      series: Array<{ name: string; type: string; stack?: string; data: number[] }>
      xAxis: { data: string[] }
    }
    expect(option.series).toHaveLength(2)
    expect(option.series.every((series) => series.type === 'line' && series.stack === 'total')).toBe(true)
    expect(option.series[0].data).toEqual([10, 20])
    expect(option.xAxis.data).toEqual(['10/29', '10/30'])
  })
})
