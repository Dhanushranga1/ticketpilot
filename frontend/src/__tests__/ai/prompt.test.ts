/**
 * @jest-environment jsdom
 */

import {
  buildAISuggestionQuery,
  prepareTicketContext,
  redactPII,
} from '@/lib/ai/prompt';

describe('AI Prompt Utilities', () => {
  describe('redactPII', () => {
    it('should redact email addresses', () => {
      const text = 'Contact John at john.doe@example.com for details';
      const result = redactPII(text);
      expect(result).toBe('Contact John at [email-redacted] for details');
    });

    it('should redact phone numbers', () => {
      const text = 'Call us at 555-123-4567 or 5551234567';
      const result = redactPII(text);
      expect(result).toBe('Call us at [phone-redacted] or [phone-redacted]');
    });

    it('should redact multiple PII types', () => {
      const text = 'Email john@test.com or call 555-123-4567';
      const result = redactPII(text);
      expect(result).toBe('Email [email-redacted] or call [phone-redacted]');
    });

    it('should handle text without PII', () => {
      const text = 'This is a normal message without sensitive data';
      const result = redactPII(text);
      expect(result).toBe(text);
    });
  });

  describe('prepareTicketContext', () => {
    const mockTicket = {
      id: 'ticket-123',
      title: 'Login Issue',
      priority: 'high',
      status: 'open',
      customer_name: 'John Doe',
      customer_email: 'john@example.com',
    };

    const mockMessages = [
      {
        sender_role: 'customer',
        body: 'I cannot log into my account',
        timestamp: '2025-01-01T10:00:00Z',
      },
      {
        sender_role: 'rep',
        body: 'Let me help you with that',
        timestamp: '2025-01-01T10:05:00Z',
      },
    ];

    it('should prepare ticket context correctly', () => {
      const context = prepareTicketContext(mockTicket, mockMessages);

      expect(context.title).toBe('Login Issue');
      expect(context.priority).toBe('high');
      expect(context.status).toBe('open');
      expect(context.customer).toBe('John Doe');
      expect(context.customerEmail).toBe('john@example.com');
      expect(context.recentMessages).toHaveLength(2);
      expect(context.recentMessages[0].role).toBe('customer');
      expect(context.recentMessages[1].role).toBe('rep');
    });

    it('should handle missing messages', () => {
      const context = prepareTicketContext(mockTicket, []);
      expect(context.recentMessages).toHaveLength(0);
    });

    it('should filter out empty messages', () => {
      const messagesWithEmpty = [
        ...mockMessages,
        { sender_role: 'system', body: '', timestamp: '2025-01-01T10:10:00Z' },
      ];

      const context = prepareTicketContext(mockTicket, messagesWithEmpty);
      expect(context.recentMessages).toHaveLength(2);
    });

    it('should handle unknown sender roles', () => {
      const messagesWithUnknown = [
        {
          sender_role: 'unknown',
          body: 'Test message',
          timestamp: '2025-01-01T10:00:00Z',
        },
      ];

      const context = prepareTicketContext(mockTicket, messagesWithUnknown);
      expect(context.recentMessages[0].role).toBe('system');
    });
  });

  describe('buildAISuggestionQuery', () => {
    const mockContext = {
      title: 'Password Reset Request',
      priority: 'medium',
      status: 'open',
      customer: 'Jane Smith',
      recentMessages: [
        {
          role: 'customer' as const,
          text: 'I forgot my password and need help resetting it',
          timestamp: new Date('2025-01-01T10:00:00Z'),
        },
        {
          role: 'rep' as const,
          text: 'I can help you with that. Let me send you a reset link.',
          timestamp: new Date('2025-01-01T10:05:00Z'),
        },
      ],
    };

    it('should build a comprehensive prompt', () => {
      const query = buildAISuggestionQuery(mockContext);

      expect(query).toContain("TicketPilot's support copilot");
      expect(query).toContain('Password Reset Request');
      expect(query).toContain('Priority: medium');
      expect(query).toContain('Status: open');
      expect(query).toContain('Customer: Jane Smith'); // Name is used as-is (no PII in name)
      expect(query).toContain('CUSTOMER: I forgot my password');
      expect(query).toContain('REP: I can help you');
      expect(query).toContain('[ESCALATE RECOMMENDED]');
    });

    it('should handle empty message history', () => {
      const contextWithoutMessages = {
        ...mockContext,
        recentMessages: [],
      };

      const query = buildAISuggestionQuery(contextWithoutMessages);
      expect(query).toContain('(no recent messages)');
    });

    it('should truncate long messages', () => {
      const longMessage = 'A'.repeat(300); // Longer than 200 char limit
      const contextWithLongMessage = {
        ...mockContext,
        recentMessages: [
          {
            role: 'customer' as const,
            text: longMessage,
            timestamp: new Date('2025-01-01T10:00:00Z'),
          },
        ],
      };

      const query = buildAISuggestionQuery(contextWithLongMessage);
      expect(query).toContain('A'.repeat(200) + '...');
    });

    it('should limit to 5 recent messages', () => {
      const manyMessages = Array.from({ length: 10 }, (_, i) => ({
        role: 'customer' as const,
        text: `Message ${i + 1}`,
        timestamp: new Date(
          `2025-01-01T10:${i.toString().padStart(2, '0')}:00Z`
        ),
      }));

      const contextWithManyMessages = {
        ...mockContext,
        recentMessages: manyMessages,
      };

      const query = buildAISuggestionQuery(contextWithManyMessages);

      // Should only contain the last 5 messages (6-10)
      expect(query).toContain('Message 6');
      expect(query).toContain('Message 10');
      // Message 1 and 5 should be excluded (use word boundary to avoid substring matches)
      expect(query).not.toMatch(/CUSTOMER: Message 1\b/);
      expect(query).not.toMatch(/CUSTOMER: Message 5\b/);
    });

    it('should include proper guidelines', () => {
      const query = buildAISuggestionQuery(mockContext);

      expect(query).toContain('4-6 sentences maximum');
      expect(query).toContain('professional, clear, and calming');
      expect(query).toContain('plain text');
      expect(query).toContain('no placeholders');
    });
  });
});
