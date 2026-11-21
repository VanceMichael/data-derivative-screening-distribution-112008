// 简单的文件持久化：保存已下发的命令、收到的回执和审计记录。
// 目录不存在时自动创建；写入走临时文件再改名，避免半截 JSON。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createFilePersistence(path) {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    save(value) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value, null, 2));
      renameSync(temporary, path);
    },
  };
}
