export interface Env {
	BOT_INFO: string;
	BOT_TOKEN: string;
	OPENAI_API_KEY: string;
	CONVERSATION_HISTORY: KVNamespace;
	LEADERBOARD: KVNamespace;
	USER_LANGUAGE: KVNamespace;
}

export type MessageRole = 'user' | 'assistant';

export interface ConversationMessage {
	role: MessageRole;
	content: string;
}

export interface ScheduledEvent {
	scheduledTime: number;
	cron: string;
}

export interface AutomatedUpdate {
	type: 'sports' | 'finance' | 'prematch';
	content: string;
	timestamp: number;
}

export interface ActiveChat {
	id: string;
	type: 'private' | 'group';
	title?: string;
	username?: string;
	lastActivity: number;
}

export interface ActiveChats {
	private: Record<string, ActiveChat>;
	groups: Record<string, ActiveChat>;
}
