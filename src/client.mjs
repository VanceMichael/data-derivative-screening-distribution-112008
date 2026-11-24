// 本地合成上游客户端：采集编目、授权登记、展期安排与终端回执。
// 所有接口均为本地演练服务，不传输真实影音。

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`来源请求失败 GET ${url}：HTTP ${response.status}`);
  }
  return response.json();
}

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`来源请求失败 GET ${url}：HTTP ${response.status}`);
  }
  return response.text();
}

export class SourceClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async health() {
    return getJson(`${this.baseUrl}/health`);
  }

  async getCatalog() {
    return getText(`${this.baseUrl}/catalog`);
  }

  async getLinks() {
    return getJson(`${this.baseUrl}/catalog/links`);
  }

  async getSchedule() {
    return getJson(`${this.baseUrl}/exhibits/schedule`);
  }

  async getRightsEntries() {
    return getJson(`${this.baseUrl}/rights/entries`);
  }

  async getAmendments() {
    return getJson(`${this.baseUrl}/rights/amendments`);
  }

  async getReceipts() {
    return getJson(`${this.baseUrl}/player/receipts`);
  }

  /** 向分发服务投递命令；202/arrived 只表示请求到达，不代表设备已应用。 */
  async postCommand(command) {
    const response = await fetch(`${this.baseUrl}/player/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!response.ok) {
      throw new Error(`命令投递失败：HTTP ${response.status}`);
    }
    return response.json();
  }
}
