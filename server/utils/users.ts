import { storage } from "../storage";

// Helper function to resolve identifier (UUID or username) to userId
export async function resolveUserId(identifier: string): Promise<string | null> {
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  if (isUUID) {
    const user = await storage.getUser(identifier);
    return user?.id || null;
  } else {
    const user = await storage.getUserByUsername(identifier);
    return user?.id || null;
  }
}
