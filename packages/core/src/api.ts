import type {
  Conversation,
  Delivery,
  DeliveryReceipt,
  Membership,
  Message,
  RoomPolicy,
  Session,
} from "./types.js";

/** Narrow Bus API shared by UI RPC and MCP facades. */
export type PortageBusApi = {
  listSessions(): Promise<Session[]>;
  listRooms(): Promise<Conversation[]>;
  getMemberships(conversationId: string): Promise<Membership[]>;
  getRoomPolicy(conversationId: string): Promise<RoomPolicy>;

  joinRoom(input: { conversationId: string; participantId: string }): Promise<Membership>;
  leaveRoom(input: { conversationId: string; participantId: string }): Promise<Membership>;

  setWakeMode(input: {
    conversationId: string;
    mode: RoomPolicy["wakeMode"];
    coordinatorParticipantId?: string;
  }): Promise<RoomPolicy>;

  send(input: {
    conversationId: string;
    senderId: string;
    target: Message["target"];
    text: string;
    mentionParticipantIds?: string[];
    idempotencyKey: string;
    traceId?: string;
    causalParentIds?: string[];
    source?: Message["source"];
    isManualWake?: boolean;
  }): Promise<{ message: Message; deliveries: Delivery[] }>;

  listMessages(conversationId: string): Promise<Message[]>;
  listInbox(sessionId: string): Promise<Delivery[]>;
  getReceipts(deliveryId: string): Promise<DeliveryReceipt[]>;
};
