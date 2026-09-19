import { buildTrafficWorkbookExportUrl, type TrafficWorkbookExportRequest } from './trafficWorkbookExportContract.ts';

export function buildTrafficHtmlExportUrl(request: TrafficWorkbookExportRequest): string {
  const url=new URL(buildTrafficWorkbookExportUrl(request),'https://report.invalid');
  url.pathname='/api/report/v2/html-export';
  url.searchParams.delete('template_version');
  url.searchParams.set('html_template',request.reportType==='WEEKLY_DETAIL'?'weekly-detail-v1'
    :request.reportType==='BAO_CAO_SAN_LUONG'?'bao-cao-san-luong-v1':'period-analysis-v1');
  return `${url.pathname}?${url.searchParams}`;
}
