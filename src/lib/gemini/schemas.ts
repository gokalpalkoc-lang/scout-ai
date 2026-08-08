import { SchemaNode } from './types';

/**
 * Response schemas for structured extraction.
 *
 * Gemini honours `responseSchema` strictly, which removes the whole class of
 * "model returned prose instead of JSON" failures. Every date field is a string
 * rather than a format-checked date because real pages publish partial dates,
 * and a date-only value is more useful than a dropped event.
 */

export const EVENT_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Name of the event, verbatim from the page. Never invent one.',
    },
    startsAt: {
      type: 'string',
      description:
        'Start as ISO-8601. Use YYYY-MM-DD when no time is published, YYYY-MM-DDTHH:mm when it is. Empty string if the page gives no date at all.',
    },
    endsAt: {
      type: 'string',
      description: 'End in the same format as startsAt, or empty string if not published.',
    },
    allDay: {
      type: 'boolean',
      description: 'True when the page gives no clock time for the event.',
    },
    location: {
      type: 'string',
      description: 'Venue, city or "Online". Empty string if not stated.',
    },
    url: {
      type: 'string',
      description:
        'The most specific link for this event, taken from a <url> marker in the page text. Empty string if none.',
    },
    price: {
      type: 'string',
      description: 'Ticket price or fee exactly as written, e.g. "Free", "250 TL", "€30–60".',
    },
    category: {
      type: 'string',
      description:
        'One short lowercase label: concert, conference, workshop, exhibition, sport, festival, theatre, meetup, deadline, course, screening, other.',
    },
    description: {
      type: 'string',
      description: 'One or two sentences of useful detail. Empty string if the page adds nothing.',
    },
    deadlineAt: {
      type: 'string',
      description:
        'Registration, application or ticket-sale cutoff as ISO-8601, if the page states one. Empty string otherwise.',
    },
    deadlineLabel: {
      type: 'string',
      description: 'What the deadline is for, e.g. "abstract submission", "early-bird tickets".',
    },
    confidence: {
      type: 'number',
      description:
        '0.0–1.0. How sure you are this is a real, distinct event with a correct date. Below 0.4 for guesses.',
    },
  },
  required: ['title', 'startsAt', 'allDay', 'confidence'],
  propertyOrdering: [
    'title',
    'startsAt',
    'endsAt',
    'allDay',
    'location',
    'url',
    'price',
    'category',
    'description',
    'deadlineAt',
    'deadlineLabel',
    'confidence',
  ],
};

export const EXTRACTION_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    pageKind: {
      type: 'string',
      description:
        'What this page is: "listing" (many events), "single" (one event), "none" (no events), or "blocked" (a cookie wall, login or JS-only shell).',
      enum: ['listing', 'single', 'none', 'blocked'],
    },
    events: { type: 'array', items: EVENT_SCHEMA },
    note: {
      type: 'string',
      description:
        'One short sentence for the user: what you found, or why you found nothing. Plain language.',
    },
  },
  required: ['pageKind', 'events', 'note'],
  propertyOrdering: ['pageKind', 'events', 'note'],
};

export const CHANGE_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    significant: {
      type: 'boolean',
      description:
        'True only if a person watching this page would want to be told. False for cosmetic edits, rotating banners, counters, ads or reordering.',
    },
    headline: {
      type: 'string',
      description: 'Notification-ready summary, under 90 characters, no trailing period.',
    },
    detail: {
      type: 'string',
      description: 'Two or three sentences on what actually changed.',
    },
    kind: {
      type: 'string',
      description: 'The nature of the change.',
      enum: ['new-items', 'removed-items', 'date-change', 'content-edit', 'cosmetic', 'error-page'],
    },
  },
  required: ['significant', 'headline', 'kind'],
  propertyOrdering: ['significant', 'headline', 'detail', 'kind'],
};

export const DIGEST_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'Notification title, under 60 characters.',
    },
    body: {
      type: 'string',
      description: 'Notification body, under 220 characters, the most useful items first.',
    },
    full: {
      type: 'string',
      description:
        'The complete digest as short markdown, grouped by day. Use "- " bullets and bold for names.',
    },
  },
  required: ['headline', 'body', 'full'],
  propertyOrdering: ['headline', 'body', 'full'],
};
