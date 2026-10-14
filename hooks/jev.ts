import type { EngineInterface } from 'claude-code'

export type Route = 'haiku' | 'opus' | 'fable' | 'image'
export const ROUTES: readonly Route[] = ['haiku', 'opus', 'fable', 'image']

export type Classification = {
  source: 'jev' | 'fallback-haiku' | 'default'
  route: Route
  confidence: number
  probabilities: Partial<Record<Route, number>>
  securitySensitive: number
  premiumImage: number
  jevModel?: string
  latencyMs: number
  error?: string
}

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

// What each route is for. Jev reads these as the Choice criteria, so they are the routing policy.
export const ROUTE_CRITERIA: Record<Route, string> = {
  haiku:
    'Quick, low-stakes work: a lookup, a question about the code answered by reading one or two files, a summary, a commit message, formatting, renaming, a one-line fix, or a conversational reply.',
  opus:
    'Ordinary engineering work: writing or changing code across a few files, debugging with a clear trail, writing tests, reviewing a change, or a design question with a known shape.',
  fable:
    'The hardest work: architecture across a whole codebase, long multi-step agentic tasks, deep debugging with no clear lead, ambiguous problems needing extended reasoning, or high-stakes design decisions.',
  image:
    'The request is mainly to create, generate, draw, edit, restyle or retouch an image, picture, illustration, logo, icon, mockup image, photo or other graphic.',
}

/** Ask Jev which route fits. Throws on any transport or schema problem so the caller can fall back. */
export async function classifyWithJev($: EngineInterface, apiKey: string, state: string): Promise<Classification> {
  const started = await $.clock.now()
  const res = await $.http.fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state,
      questions: {
        route: {
          type: 'choice',
          instructions: 'Which model tier should handle this request to a coding agent',
          criteria: ROUTE_CRITERIA,
        },
        security: {
          type: 'noul',
          instructions:
            'The request involves security work: exploits, vulnerabilities, malware, penetration testing, attack techniques or security tooling',
        },
        premium_image: {
          type: 'noul',
          instructions:
            'The request asks for a polished, final, production-ready or campaign-quality image rather than a quick draft',
        },
      },
    }),
  })
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${res.text.slice(0, 200)}`)

  const body = JSON.parse(res.text) as {
    model?: string
    answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>
  }
  const route = body.answers?.route
  const choice = route?.choice
  if (!route || !isRoute(choice)) throw new Error('Jev answered without a usable route')

  const probabilities: Partial<Record<Route, number>> = {}
  for (const r of ROUTES) {
    const p = route.probabilities?.[r]
    if (typeof p === 'number') probabilities[r] = p
  }
  return {
    source: 'jev',
    route: choice,
    confidence: typeof route.confidence === 'number' ? route.confidence : (probabilities[choice] ?? 0),
    probabilities,
    securitySensitive: body.answers?.security?.noul ?? 0,
    premiumImage: body.answers?.premium_image?.noul ?? 0,
    jevModel: body.model,
    latencyMs: (await $.clock.now()) - started,
  }
}

/** Fallback when Jev is unavailable: one-word Haiku classification. Never throws. */
export async function classifyWithHaiku($: EngineInterface, state: string, jevError: string): Promise<Classification> {
  const started = await $.clock.now()
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system:
        'You route requests for a coding agent. Reply with exactly one word: haiku, opus, fable or image.\n' +
        ROUTES.map(k => `${k}: ${ROUTE_CRITERIA[k]}`).join('\n'),
      prompt: state,
      maxTokens: 5,
      timeoutMs: 8000,
    })
    const word = r.isAnswered ? r.text.trim().toLowerCase().replace(/[^a-z]/g, '') : ''
    if (isRoute(word)) {
      return {
        source: 'fallback-haiku',
        route: word,
        // A one-word answer carries no calibrated confidence: treat it as unsure enough to show, sure enough not to ask.
        confidence: 0.75,
        probabilities: { [word]: 0.75 },
        securitySensitive: 0,
        premiumImage: 0,
        latencyMs: (await $.clock.now()) - started,
        error: jevError,
      }
    }
  } catch {
    // fall through to the default
  }
  return defaultClassification(jevError)
}

export function defaultClassification(error: string): Classification {
  return {
    source: 'default',
    route: 'opus',
    confidence: 1,
    probabilities: { opus: 1 },
    securitySensitive: 0,
    premiumImage: 0,
    latencyMs: 0,
    error,
  }
}

export function isRoute(x: unknown): x is Route {
  return typeof x === 'string' && (ROUTES as readonly string[]).includes(x)
}

/** The routes ranked by Jev's probability, highest first. */
export function ranked(c: Classification): Route[] {
  return [...ROUTES].sort((a, b) => (c.probabilities[b] ?? 0) - (c.probabilities[a] ?? 0))
}
