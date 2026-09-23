export interface CustomerDeviceDTO {
  id: string;
  customer_id: string;
  device_id: string;
  platform: string;
  last_seen_at: Date | null;
  created_at: Date | null;
  is_active: boolean;
}

export interface ActiveCustomerDevice {
  id: string;
  customer_id: string;
  device_id: string;
  fcm_token: string;
  platform: string;
}

export interface RegisterCustomerDeviceReq {
  device_id?: string;
  device_token: string;
  platform?: string;
}

export function toCustomerDeviceDTO(device: any): CustomerDeviceDTO | null {
  if (!device) return null;
  return {
    id: device.id,
    customer_id: device.customer_id,
    device_id: device.device_id,
    platform: device.platform,
    last_seen_at: device.last_seen_at ?? null,
    created_at: device.created_at ?? null,
    is_active: !device.revoked_at,
  };
}
