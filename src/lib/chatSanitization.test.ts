import test from "node:test";
import assert from "node:assert/strict";

import {
  isPlaceholderOnlyAssistantContent,
  sanitizeAssistantDisplayContent,
  shouldRenderMediaAttachment,
} from "./chatSanitization";

test("sanitizeAssistantDisplayContent removes local paths and prompt dumps", () => {
  const result = sanitizeAssistantDisplayContent(`
NV Media da tao xong media (image), dang cho Sep duyet.
Anh san pham goc da dung: C:\\Users\\Administrator\\.openclaw\\workspace_content\\artifacts\\references\\product.png
Logo da dung: C:\\Users\\Administrator\\.openclaw\\assets\\logos\\logo.png
PROMPT ANH DA DUNG:
Tao anh quang cao dai rat dai...

Duyet va sang buoc tiep: "Duyet anh va dang bai"
`);

  assert.match(result, /NV Media da tao xong media/);
  assert.match(result, /Duyet va sang buoc tiep/);
  assert.doesNotMatch(result, /workspace_content/);
  assert.doesNotMatch(result, /PROMPT ANH DA DUNG/);
  assert.doesNotMatch(result, /logo\.png/);
});

test("shouldRenderMediaAttachment keeps generated media and hides internal references", () => {
  assert.equal(
    shouldRenderMediaAttachment("C:/Users/Administrator/.openclaw/workspace_media/artifacts/images/generated.png"),
    true,
  );
  assert.equal(
    shouldRenderMediaAttachment("C:/Users/Administrator/.openclaw/workspace_content/artifacts/references/product.png"),
    false,
  );
  assert.equal(
    shouldRenderMediaAttachment("C:/Users/Administrator/.openclaw/assets/logos/logo.png"),
    false,
  );
});

test("placeholder-only assistant content is hidden", () => {
  assert.equal(isPlaceholderOnlyAssistantContent("."), true);
  assert.equal(isPlaceholderOnlyAssistantContent("..."), true);
  assert.equal(isPlaceholderOnlyAssistantContent("Dang xu ly"), false);
  assert.equal(sanitizeAssistantDisplayContent("..."), "");
});

test("sanitizeAssistantDisplayContent keeps publish identifiers but strips internal media paths", () => {
  const result = sanitizeAssistantDisplayContent(`
Sep da duyet content, anh va video. Da san sang dang bai.
Anh se dang:
MEDIA: "C:/Users/Administrator/.openclaw/workspace_media/artifacts/images/generated.png"
Video se dang trong luot nay:
MEDIA: "C:/Users/Administrator/.openclaw/workspace_media_video/artifacts/videos/wf_demo/video.mp4"
Dang ngay: "Dang ngay"

Bai viet da duoc dang thanh cong len Fanpage.
Page IDs: 1021996431004626, 1129362243584971
Post IDs: 1021996431004626_122108104010824730, 1129362243584971_122107239164848931
`);

  assert.match(result, /Da san sang dang bai/);
  assert.match(result, /Dang ngay: "Dang ngay"/);
  assert.match(result, /Page IDs: 1021996431004626/);
  assert.match(result, /Post IDs: 1021996431004626_122108104010824730/);
  assert.doesNotMatch(result, /workspace_media/);
  assert.doesNotMatch(result, /workspace_media_video/);
});
