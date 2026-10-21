// What gamers live can do on this server (GET /api/rooms/config). Only asked for once a room actually carries a game, so a
// room with the flag off never makes this request.
import { useQuery } from "@tanstack/react-query";
import { fetchRoomsConfig } from "@/lib/roomsApi";
import { gameCaps, NO_GAME_CAPS, type GameCaps } from "@/lib/gameScreen";

export function useGameCaps(enabled: boolean): GameCaps {
  const q = useQuery({ queryKey: ["/api/rooms/config"], queryFn: fetchRoomsConfig, staleTime: 5 * 60 * 1000, enabled });
  return enabled ? gameCaps(q.data) : NO_GAME_CAPS;
}
