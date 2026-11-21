// 来源服务客户端。所有路径都相对同一个来源地址，超时与错误统一抛出可读错误。

export class SourceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SourceError';
    this.path = options.path;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export function createSourceClient({ baseUrl, timeoutMs = 5000, fetchImpl = globalThis.fetch }) {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(path, options = {}) {
    const { method = 'GET', body, headers } = options;
    let response;
    try {
      response = await fetchImpl(root + path, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SourceError(`来源请求失败：${method} ${path}（${error.message}）`, { path, cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new SourceError(`来源返回 ${response.status}：${method} ${path}`, { path, status: response.status });
    }
    return { response, text };
  }

  return {
    baseUrl: root,

    async fetchText(path) {
      return (await request(path)).text;
    },

    async fetchJson(path) {
      const { text } = await request(path);
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new SourceError(`来源返回的不是 JSON：${path}`, { path, cause: error });
      }
    },

    // 命令入口只表示请求到达；应用状态必须看 /player/receipts。
    async postCommand(command) {
      const { text } = await request('/player/commands', { method: 'POST', body: command });
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    },
  };
}
