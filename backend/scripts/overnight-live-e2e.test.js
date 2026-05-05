const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectStageFromMessage,
  extractPostId,
  hasUserFacingLeak,
} = require("./overnight-live-e2e.js");

test("detectStageFromMessage treats plural Post IDs publish result as published", () => {
  assert.equal(
    detectStageFromMessage({
      role: "assistant",
      type: "regular",
      content: "Bai viet da duoc dang thanh cong.\nPost IDs: 102_200, 103_300",
    }),
    "published",
  );
});

test("extractPostId returns the first canonical post id from plural publish result", () => {
  assert.equal(
    extractPostId("Bai viet da duoc dang thanh cong.\nPost IDs: 102_200, 103_300"),
    "102_200",
  );
});

test("hasUserFacingLeak ignores generated media attachment lines but still catches local path leaks", () => {
  assert.equal(
    hasUserFacingLeak('MEDIA: "C:/Users/Administrator/.openclaw/workspace_media/artifacts/images/generated.png"\nDa dung 1 logo cong ty.'),
    false,
  );
  assert.equal(
    hasUserFacingLeak("Anh san pham goc da dung: C:\\Users\\Administrator\\.openclaw\\workspace_content\\artifacts\\references\\product.png"),
    true,
  );
});
