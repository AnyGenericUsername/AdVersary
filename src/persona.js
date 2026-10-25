// src/persona.js
//
// Persona seed graphs. Each persona is a set of topical nodes. A node holds a
// small query corpus (fed to the word-level Markov query generator) and a set
// of seed domains (entry points for direct visits). `transitions` is the
// topic-level Markov chain: the relative weight of moving from one topic to
// the next. Self-loops keep sessions topically coherent, the way real
// browsing clusters around an interest before drifting.
//
// Rows/columns omitted from `transitions` get weight 0; a topic with no row
// at all transitions uniformly.

export const FEMALE_PERSONA_GRAPH = {
  id: "female_lifestyle",
  label: "Female lifestyle, 25–40",
  topics: {
    skincare: {
      queries: [
        "hyaluronic acid vs retinol routine",
        "ceramide barrier repair moisturizer",
        "best vitamin c serum for sensitive skin",
        "niacinamide and retinol together routine",
        "mineral sunscreen for daily wear under makeup",
        "korean skincare routine steps for dry skin",
        "gentle exfoliating toner for sensitive skin",
        "best night cream for fine lines"
      ],
      seed_domains: ["sephora.com", "ulta.com", "allure.com", "byrdie.com"]
    },
    makeup: {
      queries: [
        "best long wear foundation for combination skin",
        "clean beauty tinted moisturizer",
        "everyday natural makeup look tutorial",
        "best waterproof mascara for sensitive eyes",
        "cream blush vs powder blush for mature skin",
        "lip liner and gloss combo for everyday"
      ],
      seed_domains: ["sephora.com", "ulta.com", "glossier.com", "refinery29.com"]
    },
    apparel: {
      queries: [
        "high waisted wide leg linen trousers",
        "sustainable women's workwear",
        "midi wrap dress for summer wedding guest",
        "women's capsule wardrobe essentials fall",
        "best women's leather ankle boots",
        "petite tailored blazer for women"
      ],
      seed_domains: ["reformation.com", "nordstrom.com", "aritzia.com", "madewell.com"]
    },
    parenting_maternity: {
      queries: [
        "best trimester 2 prenatal vitamins",
        "postpartum recovery checklist",
        "maternity jeans that actually fit",
        "baby registry must haves first time moms",
        "nursing friendly dresses for summer",
        "how to prepare hospital bag for birth"
      ],
      seed_domains: ["whattoexpect.com", "thebump.com", "babylist.com"]
    },
    wellness_fitness: {
      queries: [
        "beginner pilates routine at home",
        "best women's running shoes for flat feet",
        "high waisted leggings with pockets for yoga",
        "cycle syncing workout plan",
        "iron rich meal prep ideas for women",
        "best collagen powder for hair and nails"
      ],
      seed_domains: ["womenshealthmag.com", "lululemon.com", "self.com", "wellandgood.com"]
    },
    home_decor: {
      queries: [
        "cozy neutral bedroom decor ideas",
        "linen duvet cover set queen",
        "scandinavian living room styling tips",
        "best scented candles for home",
        "small apartment entryway organization ideas"
      ],
      seed_domains: ["anthropologie.com", "westelm.com", "apartmenttherapy.com"]
    }
  },
  transitions: {
    skincare:            { skincare: 4, makeup: 3, wellness_fitness: 2, apparel: 1 },
    makeup:              { makeup: 3, skincare: 3, apparel: 2, home_decor: 1 },
    apparel:             { apparel: 4, makeup: 1, home_decor: 2, wellness_fitness: 1, parenting_maternity: 1 },
    parenting_maternity: { parenting_maternity: 4, wellness_fitness: 2, home_decor: 2, apparel: 1 },
    wellness_fitness:    { wellness_fitness: 3, skincare: 2, apparel: 2, parenting_maternity: 1 },
    home_decor:          { home_decor: 3, apparel: 2, parenting_maternity: 1, skincare: 1 }
  },
  // Path fragments that indicate product detail pages. The link picker
  // prefers these when following same-site links, producing "view_item"
  // style signals (product page views) without transacting.
  productLinkPatterns: ["/product", "/products/", "/p/", "/dp/", "/shop/", "/item", "/buy/"]
};

export const PERSONAS = {
  [FEMALE_PERSONA_GRAPH.id]: FEMALE_PERSONA_GRAPH
};

export const DEFAULT_PERSONA_ID = FEMALE_PERSONA_GRAPH.id;

export function getPersona(id) {
  return PERSONAS[id] ?? PERSONAS[DEFAULT_PERSONA_ID];
}
