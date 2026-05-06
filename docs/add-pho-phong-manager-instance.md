# Hướng dẫn thêm tài khoản phó phòng manager instance mới

Tài liệu này dùng khi muốn thêm một tài khoản phó phòng mới chạy cùng base agent `pho_phong`, nhưng có luồng automation riêng như:

- `pho_phong_a` -> `mgr_pho_phong_A`
- `pho_phong_b` -> `mgr_pho_phong_B`
- `pho_phong_c` -> `mgr_pho_phong_C`

Mục tiêu là mỗi tài khoản dùng chung agent template `pho_phong` và chung worker templates `nv_content`, `nv_media`, `nv_prompt`, nhưng phải tách riêng:

- `managerInstanceId`
- conversation
- automation session key
- workflow state
- worker task context

Ví dụ bên dưới dùng instance mới `pho_phong_d` / `mgr_pho_phong_D`. Khi thêm instance khác, thay `D` bằng ký hiệu mong muốn.

## 1. Quy ước đặt tên

Chọn trước các giá trị sau:

```text
employeeId: pho_phong_d
email: pho_phong_d@uptek.ai
displayName: Phó Phòng D KD2
lockedAgentId: pho_phong
managerInstanceId: mgr_pho_phong_D
department: KD2 hoặc KD1 tùy nhu cầu
defaultWorkers: nv_content, nv_media, nv_prompt
```

Lưu ý quan trọng:

- `lockedAgentId` vẫn là `pho_phong` vì đây là base agent template.
- `managerInstanceId` phải là giá trị mới riêng, ví dụ `mgr_pho_phong_D`.
- Không dùng lại `mgr_pho_phong_A/B/C`, nếu không automation sẽ dùng chung state.

## 2. Sửa migration DB

File:

```text
backend/migrate.js
```

Trong phần seed `manager_instances`, thêm block:

```js
await pool.query(`
  INSERT INTO "manager_instances" ("id", "baseAgentKey", "label", "status")
  VALUES ('mgr_pho_phong_D', 'pho_phong', 'Pho Phong D (KD2)', 'active')
  ON CONFLICT ("id") DO NOTHING
`);
```

Trong phần worker bindings, thêm instance mới vào `managerIds`:

```js
const workerAgents = ['nv_content', 'nv_media', 'nv_prompt'];
const managerIds = [
  'mgr_pho_phong_A',
  'mgr_pho_phong_B',
  'mgr_pho_phong_C',
  'mgr_pho_phong_D',
];
```

Trong phần seed `UserAgentAccess` cho `nv_assistant`, thêm employee mới nếu muốn mặc định chưa bật assistant:

```js
for (const employeeId of ['pho_phong_a', 'pho_phong_b', 'pho_phong_c', 'pho_phong_d']) {
  await pool.query(`
    INSERT INTO "UserAgentAccess" ("employeeId", "agentId", "enabled", "grantedBy")
    VALUES ($1, 'nv_assistant', false, 'system')
    ON CONFLICT ("employeeId", "agentId") DO NOTHING
  `, [employeeId]);
}
```

## 3. Sửa auth mapping

File:

```text
backend/src/auth.js
```

Tìm hàm:

```js
function resolveManagerInstanceIdForEmployee(config, employeeId, employeeName) {
```

Thêm mapping:

```js
if (normalizedEmployeeId === "pho_phong_d") {
  return "mgr_pho_phong_D";
}
```

Ý nghĩa:

- Khi `pho_phong_d` login, backend trả về `accessPolicy.managerInstanceId = mgr_pho_phong_D`.
- Frontend sẽ dùng giá trị này để tạo session automation riêng:

```text
automation:pho_phong:mgr_pho_phong_D:conv_xxx
```

## 4. Seed user account trong backend

File:

```text
backend/src/user-management.js
```

Thêm constant:

```js
const PHO_PHONG_D_EMPLOYEE_ID = "pho_phong_d";
```

Thêm mapping manager instance nếu file đang có hàm `resolveUserManagerInstanceId`:

```js
function resolveUserManagerInstanceId(employeeId) {
  if (employeeId === "pho_phong_a") return "mgr_pho_phong_A";
  if (employeeId === "pho_phong_b") return "mgr_pho_phong_B";
  if (employeeId === "pho_phong_c") return "mgr_pho_phong_C";
  if (employeeId === "pho_phong_d") return "mgr_pho_phong_D";
  return undefined;
}
```

Thêm hàm seed user:

```js
async function ensurePhoPhongDUser() {
  const existing = await findUserByEmployeeId(PHO_PHONG_D_EMPLOYEE_ID);
  const defaultVisibleAgentIds = resolveVisibleAgentIdsForUser(
    { employeeId: PHO_PHONG_D_EMPLOYEE_ID, lockedAgentId: "pho_phong" },
    [],
  );

  if (!existing) {
    await pool.query(
      `INSERT INTO "system_users"
        ("id", "email", "password", "employee_id", "employee_name", "role", "status",
         "locked_agent_id", "can_view_all_sessions", "visible_agent_ids", "lock_agent",
         "lock_session", "auto_connect")
       VALUES ($1, $2, $3, $1, $4, $1, 'active', 'pho_phong', false, $5, true, false, true)
       ON CONFLICT ("id") DO NOTHING`,
      [
        PHO_PHONG_D_EMPLOYEE_ID,
        "pho_phong_d@uptek.ai",
        "1",
        "Phó Phòng D KD2",
        serializeJsonArray(defaultVisibleAgentIds),
      ],
    );
    return;
  }

  await pool.query(
    `UPDATE "system_users"
     SET "employee_name" = $1,
         "locked_agent_id" = 'pho_phong',
         "visible_agent_ids" = $2,
         "auto_connect" = true,
         "updated_at" = NOW()
     WHERE "employee_id" = $3`,
    [
      "Phó Phòng D KD2",
      serializeJsonArray(resolveVisibleAgentIdsForUser(
        { ...existing, employeeId: PHO_PHONG_D_EMPLOYEE_ID, lockedAgentId: "pho_phong" },
        existing.visibleAgentIds || [],
      )),
      PHO_PHONG_D_EMPLOYEE_ID,
    ],
  );
}
```

Gọi hàm này trong `initializeUserStore()`:

```js
async function initializeUserStore() {
  await ensureSystemUsersTable();
  await seedUsersFromConfigIfNeeded();
  await ensurePhoPhongCUser();
  await ensurePhoPhongDUser();
  await ensureCskhManagerUser();
  await ensureDefaultAssistantUser();
  await initializeAssistantAccessStore();
  await syncUsersToConfig();
}
```

## 5. Cấu hình phòng KD1/KD2 trên frontend

File:

```text
src/components/DashboardArea.tsx
```

Hàm `resolveSalesDepartment()` phân nhóm hiển thị phòng ban. Nếu muốn `pho_phong_d` thuộc KD2, thêm rule vào nhánh KD2:

```ts
if (
  /\bkd[\s_-]*2\b/.test(normalizedText)
  || /\bkinh doanh[\s_-]*2\b/.test(normalizedText)
  || /\btruong[_\s-]*phong[_\s-]*kd[\s_-]*2\b/.test(normalizedText)
  || /\bpho[_\s-]*phong[_\s-]*3\b/.test(normalizedText)
  || /\bpho[_\s-]*phong[_\s-]*4\b/.test(normalizedText)
  || /\bpho[_\s-]*phong[_\s-]*d\b/.test(normalizedText)
) {
  return "sales-2";
}
```

Nếu tên hiển thị đã có `KD2`, rule hiện tại thường đã nhận được qua `kinh doanh 2` hoặc `kd2`, nhưng thêm rule trực tiếp giúp rõ ràng hơn.

## 6. Cập nhật assistant access default

File:

```text
backend/src/assistant-access.js
```

Tìm đoạn:

```js
for (const employeeId of ["pho_phong_a", "pho_phong_b", "pho_phong_c"]) {
```

Thêm account mới:

```js
for (const employeeId of ["pho_phong_a", "pho_phong_b", "pho_phong_c", "pho_phong_d"]) {
```

Ý nghĩa:

- `nv_assistant` không tự bật mặc định cho phó phòng mới.
- Admin/giam_doc vẫn có thể cấp quyền sau.

## 7. Cập nhật skill orchestrator test

File:

```text
D:/openclaw/skills/agent-orchestrator-test/SKILL.md
```

Cập nhật danh sách manager instance:

```text
`mgr_pho_phong_A`, `mgr_pho_phong_B`, `mgr_pho_phong_C`, `mgr_pho_phong_D`
```

Cập nhật rule suy luận account:

```text
pho_phong_a dung mgr_pho_phong_A
pho_phong_b dung mgr_pho_phong_B
pho_phong_c dung mgr_pho_phong_C
pho_phong_d dung mgr_pho_phong_D
```

Thêm ví dụ lệnh test:

```bash
node D:/openclaw/skills/agent-orchestrator-test/scripts/orchestrator.js --json --openclaw-home C:/Users/PHAMDUCLONG/.openclaw --from pho_phong --manager-instance-id mgr_pho_phong_D --message-file C:/Users/PHAMDUCLONG/.openclaw/workspace_phophong/tmp/workflow-brief-D.txt
```

Thêm state file riêng:

```text
workspace_phophong/agent-orchestrator-test/managers/mgr_pho_phong_D/current-workflow.json
```

## 8. Cập nhật runtime openclaw.json ngay nếu cần dùng tức thì

File runtime:

```text
C:/Users/PHAMDUCLONG/.openclaw/openclaw.json
```

Trong `gateway.controlUi.employeeDirectory`, thêm:

```json
{
  "employeeId": "pho_phong_d",
  "employeeName": "Phó Phòng D KD2",
  "managerInstanceId": "mgr_pho_phong_D",
  "canViewAllSessions": false,
  "lockedAgentId": "pho_phong",
  "visibleAgentIds": [
    "pho_phong",
    "nv_content",
    "nv_media",
    "nv_prompt"
  ],
  "lockAgent": true,
  "lockSession": false,
  "autoConnect": true
}
```

Trong `gateway.controlUi.demoLogin.accounts`, thêm:

```json
{
  "email": "pho_phong_d@uptek.ai",
  "label": "Phó Phòng D KD2",
  "password": "1",
  "employeeId": "pho_phong_d"
}
```

Nếu backend đã chạy `syncUsersToConfig()` sau khi seed DB thì file này có thể tự được cập nhật. Nếu muốn dùng ngay không chờ restart/migrate, có thể thêm thủ công.

## 9. Cập nhật DB hiện tại nếu không chạy lại migration

Nếu cần áp dụng ngay trên DB hiện tại, chạy script tạm trong `D:/UpTek_FE/backend`:

```powershell
@'
const pool = require('./src/database');

async function main() {
  await pool.query(`
    INSERT INTO "manager_instances" ("id", "baseAgentKey", "label", "status")
    VALUES ('mgr_pho_phong_D', 'pho_phong', 'Pho Phong D (KD2)', 'active')
    ON CONFLICT ("id") DO UPDATE SET
      "baseAgentKey" = EXCLUDED."baseAgentKey",
      "label" = EXCLUDED."label",
      "status" = EXCLUDED."status",
      "updatedAt" = NOW()
  `);

  for (const workerId of ['nv_content', 'nv_media', 'nv_prompt']) {
    await pool.query(`
      INSERT INTO "manager_worker_bindings" ("managerInstanceId", "workerAgentId", "role")
      VALUES ('mgr_pho_phong_D', $1, 'worker')
      ON CONFLICT ("managerInstanceId", "workerAgentId") DO NOTHING
    `, [workerId]);
  }

  const visible = JSON.stringify(['pho_phong', 'nv_content', 'nv_media', 'nv_prompt']);
  await pool.query(`
    INSERT INTO "system_users"
      ("id", "email", "password", "employee_id", "employee_name", "role", "status",
       "locked_agent_id", "can_view_all_sessions", "visible_agent_ids", "lock_agent", "lock_session", "auto_connect")
    VALUES ('pho_phong_d', 'pho_phong_d@uptek.ai', '1', 'pho_phong_d', $1, 'pho_phong_d', 'active',
      'pho_phong', false, $2, true, false, true)
    ON CONFLICT ("id") DO UPDATE SET
      "email" = EXCLUDED."email",
      "employee_name" = EXCLUDED."employee_name",
      "role" = EXCLUDED."role",
      "locked_agent_id" = EXCLUDED."locked_agent_id",
      "visible_agent_ids" = EXCLUDED."visible_agent_ids",
      "auto_connect" = EXCLUDED."auto_connect",
      "updated_at" = NOW()
  `, ['Phó Phòng D KD2', visible]);

  await pool.query(`
    INSERT INTO "UserAgentAccess" ("employeeId", "agentId", "enabled", "grantedBy")
    VALUES ('pho_phong_d', 'nv_assistant', false, 'system')
    ON CONFLICT ("employeeId", "agentId") DO NOTHING
  `);
}

main().finally(() => pool.end());
'@ | node -
```

## 10. Kiểm tra sau khi thêm

Chạy các lệnh:

```powershell
node --check backend/migrate.js
node --check backend/src/auth.js
node --check backend/src/assistant-access.js
node --check backend/src/user-management.js
npx tsc --noEmit
```

Kiểm tra DB:

```powershell
@'
const pool = require('./src/database');

async function main() {
  const manager = await pool.query(`
    SELECT mi."id", mi."baseAgentKey", mi."status", array_agg(mwb."workerAgentId" ORDER BY mwb."workerAgentId") AS workers
    FROM "manager_instances" mi
    LEFT JOIN "manager_worker_bindings" mwb ON mwb."managerInstanceId" = mi."id"
    WHERE mi."id" = 'mgr_pho_phong_D'
    GROUP BY mi."id", mi."baseAgentKey", mi."status"
  `);
  const user = await pool.query(`
    SELECT "employee_id", "employee_name", "locked_agent_id", "visible_agent_ids"
    FROM "system_users" WHERE "employee_id" = 'pho_phong_d'
  `);
  console.log(JSON.stringify({ manager: manager.rows[0], user: user.rows[0] }, null, 2));
}

main().finally(() => pool.end());
'@ | node -
```

Kết quả đúng phải giống:

```json
{
  "manager": {
    "id": "mgr_pho_phong_D",
    "baseAgentKey": "pho_phong",
    "status": "active",
    "workers": ["nv_content", "nv_media", "nv_prompt"]
  },
  "user": {
    "employee_id": "pho_phong_d",
    "locked_agent_id": "pho_phong",
    "visible_agent_ids": "[\"pho_phong\",\"nv_content\",\"nv_media\",\"nv_prompt\"]"
  }
}
```

## 11. Test login và automation

Sau khi restart backend và OpenClaw/gateway:

1. Login bằng `pho_phong_d@uptek.ai`.
2. Kiểm tra `accessPolicy.managerInstanceId` phải là `mgr_pho_phong_D`.
3. Tạo automation conversation mới.
4. Kiểm tra session key phải có:

```text
automation:pho_phong:mgr_pho_phong_D:conv_xxx
```

5. Chạy song song với A/B/C và kiểm tra state file riêng:

```text
workspace_phophong/agent-orchestrator-test/managers/mgr_pho_phong_A/current-workflow.json
workspace_phophong/agent-orchestrator-test/managers/mgr_pho_phong_B/current-workflow.json
workspace_phophong/agent-orchestrator-test/managers/mgr_pho_phong_C/current-workflow.json
workspace_phophong/agent-orchestrator-test/managers/mgr_pho_phong_D/current-workflow.json
```

## 12. Checklist nhanh

- [ ] Có row `manager_instances.id = mgr_pho_phong_D`
- [ ] Có bindings `mgr_pho_phong_D -> nv_content/nv_media/nv_prompt`
- [ ] Có user `system_users.employee_id = pho_phong_d`
- [ ] User có `locked_agent_id = pho_phong`
- [ ] User có `visible_agent_ids` chứa `pho_phong`, `nv_content`, `nv_media`, `nv_prompt`
- [ ] `auth.js` map `pho_phong_d -> mgr_pho_phong_D`
- [ ] `openclaw.json` có `managerInstanceId = mgr_pho_phong_D`
- [ ] Skill orchestrator biết `mgr_pho_phong_D`
- [ ] Session automation mới có segment `mgr_pho_phong_D`
- [ ] State file nằm dưới folder `managers/mgr_pho_phong_D`

Nếu thiếu bất kỳ mục nào ở trên thì không nên kết luận luồng D đã tách an toàn.

