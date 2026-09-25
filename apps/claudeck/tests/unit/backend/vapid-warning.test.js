import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendFileSync = vi.fn();
vi.mock("fs", () => ({ appendFileSync: (...a) => mockAppendFileSync(...a) }));
vi.mock("../../../server/paths.js", () => ({ userDir: "/mock/home/.claudeck" }));

const mockCount = vi.fn(() => 0);
vi.mock("../../../db.js", () => ({ countPushSubscriptions: () => mockCount() }));

const { resolveVapidKeys } = await import("../../../server/vapid.js");

const webpush = {
  generateVAPIDKeys: () => ({ publicKey: "PUB", privateKey: "PRIV" }),
};

function mockLog() {
  return { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
}

describe("resolveVapidKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    mockCount.mockReturnValue(0);
  });

  it("returns configured keys without generating or warning", () => {
    process.env.VAPID_PUBLIC_KEY = "existing-pub";
    process.env.VAPID_PRIVATE_KEY = "existing-priv";
    const log = mockLog();

    const keys = resolveVapidKeys(webpush, log);

    expect(keys.publicKey).toBe("existing-pub");
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and names the file to back up when generating", () => {
    const log = mockLog();

    const keys = resolveVapidKeys(webpush, log);

    expect(keys.publicKey).toBe("PUB");
    expect(mockAppendFileSync).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("/mock/home/.claudeck/.env"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Back this file up"));
  });

  it("warns about orphaned subscriptions", () => {
    mockCount.mockReturnValue(3);
    const log = mockLog();

    resolveVapidKeys(webpush, log);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("3 existing push subscription"));
  });

  it("explains an append failure instead of crashing", () => {
    mockAppendFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const log = mockLog();

    const keys = resolveVapidKeys(webpush, log);

    expect(keys.publicKey).toBe("PUB");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("this run only"));
  });

  it("still generates when the subscription count throws", () => {
    mockCount.mockImplementation(() => {
      throw new Error("no such table");
    });
    const log = mockLog();

    expect(() => resolveVapidKeys(webpush, log)).not.toThrow();
  });
});
