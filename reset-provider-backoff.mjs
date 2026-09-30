// 清零 zcode CLI 内置 provider 的本地租约/退避状态（诊断用途）
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(homedir(), ".zcode", "v2", "runtime", "provider");
for (const arch of readdirSync(root)) {
  for (const ver of readdirSync(join(root, arch))) {
    for (const ep of readdirSync(join(root, arch, ver))) {
      const f = join(root, arch, ver, ep, "zcode-builtin-refresh.json");
      if (!existsSync(f)) continue;
      const j = JSON.parse(readFileSync(f, "utf8"));
      const before = { nextEligibleAt: j.nextEligibleAt, failureCount: j.failureCount, leaseUntil: j.leaseUntil };
      j.nextEligibleAt = 0;
      j.failureCount = 0;
      j.leaseUntil = 0;
      writeFileSync(f, JSON.stringify(j, null, 2));
      console.log(`reset ${ver}: ${JSON.stringify(before)} -> zeros`);
    }
  }
}
