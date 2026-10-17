export const SERVER_AUTHORITATIVE_MODE = true;
export const ALLOW_DURABLE_OFFLINE_WRITES = false;

export const SERVER_AUTHORITATIVE_POLICY_LABEL =
  'Ưu tiên trực tuyến: bản ghi mới nhất trên máy chủ có hiệu lực cao nhất, bộ nhớ cục bộ chỉ dùng làm bộ nhớ đệm đọc.';

export function shouldAllowDurableOfflineWrites(): boolean {
  return !SERVER_AUTHORITATIVE_MODE && ALLOW_DURABLE_OFFLINE_WRITES;
}

export function requireOnlineForServerWrite(isOnline: boolean): void {
  if (!isOnline) {
    throw new Error('Yêu cầu kết nối trực tuyến. Máy chủ là nguồn dữ liệu chuẩn.');
  }
}
