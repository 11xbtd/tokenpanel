import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useDark } from '../lib/theme'

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

export function axisColors(dark: boolean) {
  return {
    text: dark ? '#a5b3c7' : '#59677d',
    split: dark ? '#2c3748' : '#e9edf3',
    tooltipBg: dark ? '#19212d' : '#ffffff',
    tooltipBorder: dark ? '#41526a' : '#e2e7ef',
    tooltipText: dark ? '#e5ecf6' : '#202c3e',
  }
}

export function Chart({ option, height = 220 }: { option: echarts.EChartsCoreOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const dark = useDark()

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option, dark])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
