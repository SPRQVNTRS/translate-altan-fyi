/**
 * The translator pane states its language pair, and never pins one behind the
 * reader's back.
 *
 * THE DEFECT THIS EXISTS FOR. `SearchPanes` used to compute
 * `isDirectionPinned = !direction.detected` and, when that was true, write
 * `from` and `to` into hidden inputs from the RESOLVED direction. One tap on
 * the old flip chip therefore pinned that direction into every LATER
 * submission on the screen: typing the German word `umwerfen` afterwards was
 * searched with `from=en`, returned nothing, and said nothing about why. The
 * operator hit it in production. Removing the rule is the whole point of the
 * change, so the removal is what is asserted here.
 *
 * IT READS THE SOURCE, ON PURPOSE. There is no DOM library in this repo, so
 * there is no way to mount the pane and ask a browser which inputs it rendered.
 * The question is about one file's wiring, which is a question the file's own
 * text can answer. `tests/unit/voice-input-textarea-submit.test.ts` pins the
 * rest of that wiring the same way, and for the same reason.
 *
 * THE ASSERTIONS ARE SCOPED TO WHAT THEY NAME. The absence checks look for the
 * pinning IDENTIFIER and for a hidden input derived from `direction`, not for
 * the words "from" or "detected", which appear all over a file that talks about
 * both. A check that a prose comment can satisfy is a check that will one day
 * pass over the restored bug.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** The pane's own source. Read once: every case below asks something of it. */
const PANES_SOURCE = readFileSync(new URL('../../app/components/search-panes.tsx', import.meta.url), 'utf8');

/** The bar's source, which is where the two hidden inputs live now. */
const BAR_SOURCE = readFileSync(new URL('../../app/components/language-bar.tsx', import.meta.url), 'utf8');

/** The route that sizes the column the surface sits in. */
const ROUTE_SOURCE = readFileSync(new URL('../../app/routes/translate.tsx', import.meta.url), 'utf8');

/** Every `<input type="hidden" ... />` element in a source file, as text. */
function hiddenInputs(source: string): string[] {
  return [...source.matchAll(/<input\b[^>]*type="hidden"[^>]*\/>/g)].map((match) => match[0]);
}

/**
 * Every literal `className="..."` value in a source file.
 *
 * THE LAYOUT CASES BELOW ASK ABOUT CLASSES, NOT ABOUT WORDS. Both files explain
 * in prose why they no longer use a two-column grid, a wrapping flex row or a
 * brand wash, so a plain `includes('grid-cols-2')` over the whole text would
 * fail on the comment that records the fix. Reading the attributes asks the
 * question of the markup, which is where the answer lives.
 */
function classNames(source: string): string[] {
  return [...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** The class list on the outermost `<div>` a component returns, last declaration first. */
function rootClassName(source: string): string {
  const matches = [...source.matchAll(/return \(\s*<div className="([^"]*)"/g)];
  const last = matches.at(-1);
  assert.ok(last, 'no component in this file returns a <div> with a class list');
  return last[1] ?? '';
}

describe('the pane no longer pins a detected direction', () => {
  it('has no pinning rule left in it', () => {
    assert.equal(PANES_SOURCE.includes('isDirectionPinned'), false, 'the direction-pinning flag is back');
    assert.equal(PANES_SOURCE.includes('direction.detected'), false, 'the pane is reading the detection flag again');
  });

  it('emits no hidden input of its own, from the direction or from anything else', () => {
    assert.deepEqual(hiddenInputs(PANES_SOURCE), [], 'the pane is writing hidden inputs again');
  });

  it('does not render the direction chip, which was the flip link', () => {
    // The component itself stays: `entry.$headwordId.tsx` still uses it. It is
    // this screen that has a real language control now.
    assert.equal(PANES_SOURCE.includes('DirectionChip'), false, 'the flip chip is back on the translator screen');
  });

  it('renders the language bar inside the one search form', () => {
    const form = /<Form\b[^>]*>/.exec(PANES_SOURCE)?.[0];
    assert.ok(form, 'the pane no longer renders a <Form>');
    assert.match(form, /method="get"/);
    assert.match(form, /ref=\{formRef\}/);

    const bar = /<LanguageBar\b[\s\S]*?\/>/.exec(PANES_SOURCE)?.[0];
    assert.ok(bar, 'the pane no longer renders a <LanguageBar />');
    assert.match(bar, /formRef=\{formRef\}/);
    assert.match(bar, /pair=\{pair\}/);
    assert.ok(PANES_SOURCE.indexOf(form) < PANES_SOURCE.indexOf(bar), 'the bar must be inside the form, not above it');
  });
});

describe('the language bar carries the pair', () => {
  it('emits exactly one `from` and one `to`, both from the selection', () => {
    const inputs = hiddenInputs(BAR_SOURCE);
    assert.equal(inputs.length, 2, `expected two hidden inputs, got: ${inputs.join(' ')}`);

    const from = inputs.find((input) => input.includes('name="from"'));
    const to = inputs.find((input) => input.includes('name="to"'));
    assert.ok(from, 'the bar no longer sends `from`');
    assert.ok(to, 'the bar no longer sends `to`');
    // The VALUES come from the two selects, never from the resolved direction.
    // A `from` taken from `direction` is the old pinning bug wearing the new
    // component's clothes.
    assert.match(from, /value=\{source\}/);
    assert.match(to, /value=\{target\}/);
  });

  it('is not conditional on anything', () => {
    // The old rule was a conditional block around the two inputs. The pair the
    // reader can see has to be the pair every submission carries, so there is
    // no state in which these inputs are absent.
    assert.equal(BAR_SOURCE.includes('isDirectionPinned'), false);
    assert.equal(BAR_SOURCE.includes('direction.detected'), false);
  });
});

/**
 * The surface is one column, and the bar is a grid.
 *
 * THE DEFECT THESE EXIST FOR, MEASURED RATHER THAN JUDGED. The bar was a
 * wrapping flex row (`flex flex-wrap items-center gap-2`) sitting above a CSS
 * grid (`grid gap-6 md:grid-cols-2`), which are two layout systems that cannot
 * align their vertical edges. At 1280px the source select was 462px wide over a
 * 476px input pane, and the target select began 14px to the right of the column
 * it labelled. Narrowing the viewport wrapped the target select onto a line of
 * its own. The operator called the result confused and chose the shape: one
 * column at every width, with the bar as a three-cell grid.
 *
 * SO THE REGRESSION IS THE MISALIGNMENT COMING BACK, and it comes back through
 * exactly two doors: a second column on the surface, or a wrapping flex row in
 * the bar. Each door is what is watched here.
 */
describe('the translator surface is one column', () => {
  it('renders no grid on the surface at any breakpoint', () => {
    const grids = classNames(PANES_SOURCE).filter((value) => /\bgrid-cols-/.test(value));
    assert.deepEqual(grids, [], 'a column grid is back on the translator surface');
  });

  it('lays the surface out as a flex column', () => {
    const root = rootClassName(PANES_SOURCE);
    assert.match(root, /\bflex\b/);
    assert.match(root, /\bflex-col\b/);
    assert.doesNotMatch(root, /\bgrid\b/, 'the surface root is a grid again');
  });

  it('keeps the form out of the layout without `display: contents`', () => {
    // `contents` existed only so the form's children could be cells of the
    // outer grid. With no grid it hides a real box from the layout for no
    // reason, and a form that is not a box is a surprise to the next reader.
    const form = /<Form\b[^>]*>/.exec(PANES_SOURCE)?.[0];
    assert.ok(form, 'the pane no longer renders a <Form>');
    assert.doesNotMatch(form, /className="contents"/);
  });

  it('gives the input card and the answer card the same class list', () => {
    // They are one control and its reply. Two cards that differ by a brand
    // wash read as two unrelated panels stacked on each other.
    const cards = classNames(PANES_SOURCE).filter((value) => value.includes('rounded-2xl'));
    assert.equal(cards.length, 2, `expected two 2xl cards, got: ${cards.join(' | ')}`);
    assert.equal(cards[0], cards[1], 'the two cards no longer match');
  });

  it('puts no brand wash on either card', () => {
    const washed = classNames(PANES_SOURCE).filter((value) => value.includes('surface-brand'));
    assert.deepEqual(washed, [], 'a card on the translator surface carries a brand wash again');
  });

  it('keeps the route column at one width', () => {
    // `md:max-w-5xl` widened the page for a second column. There is none, so a
    // wider page is only a longer reading line.
    const widths = classNames(ROUTE_SOURCE).filter((value) => /:max-w-/.test(value));
    assert.deepEqual(widths, [], 'the route widens the column at a breakpoint again');
  });
});

describe('the language bar is a three-cell grid', () => {
  /** The one row that holds the two selects and the swap button. */
  const row = classNames(BAR_SOURCE).find((value) => value.includes('grid-cols-'));

  it('lays its three cells out with a grid, source and target equal by construction', () => {
    assert.ok(row, 'the bar row is no longer a grid');
    assert.match(row, /grid-cols-\[1fr_auto_1fr\]/, 'the two selects are no longer equal halves');
  });

  it('never wraps', () => {
    // A wrap is what dropped the target select onto its own line on a phone,
    // and what made the halves equal only by coincidence on a desktop.
    const wrapping = classNames(BAR_SOURCE).filter((value) => value.includes('flex-wrap'));
    assert.deepEqual(wrapping, [], 'the bar can wrap again');
  });

  it('fills each cell with its select', () => {
    const triggers = [...BAR_SOURCE.matchAll(/<SelectTrigger[\s\S]*?>/g)].map((match) => match[0]);
    assert.equal(triggers.length, 2, 'expected exactly two select triggers');
    for (const trigger of triggers) {
      assert.match(trigger, /\bw-full\b/, 'a select no longer fills its cell, so the bar is uneven again');
    }
  });

  it('gives all three controls a 44px tap height', () => {
    // A phone is where this row is used one-handed. The shared primitives are
    // 36px, so each control raises its own height here. The selects name the
    // `data-[size=default]` variant as well, because a variant utility outranks
    // a plain `h-11` and would silently win.
    const triggers = [...BAR_SOURCE.matchAll(/<SelectTrigger[\s\S]*?>/g)].map((match) => match[0]);
    for (const trigger of triggers) {
      assert.match(trigger, /\bh-11\b/);
      assert.match(trigger, /data-\[size=default\]:h-11/);
    }
    const swap = /<Button[\s\S]*?<\/Button>/.exec(BAR_SOURCE)?.[0];
    assert.ok(swap, 'the bar no longer renders a swap button');
    assert.match(swap, /\bsize-11\b/);
  });
});

/**
 * THE DEFECT THIS BLOCK EXISTS FOR. At a 390px viewport the source trigger is
 * 149px wide. "Detect language (Deutsch)" truncates to "Detect langu...",
 * which drops the one word a reader opened the trigger to see and keeps four
 * that carry nothing. Leading with the detected language instead truncates to
 * "Deutsch (dete...", which still shows the fact that mattered.
 *
 * THE CATALOG, NOT THE COMPONENT, IS WHAT COULD REGRESS. `language-bar.tsx`
 * already calls `t('search.detectedAs', { language: ... })` for the detected
 * state and `t('search.detectLanguage')` for both the empty trigger and the
 * dropdown option; that split is not this defect. The wording that carried the
 * bug lives in the catalog string itself, so this is what is read directly,
 * the same way the rest of this file reads component source rather than
 * mounting anything: there is no DOM library in this repo.
 */
describe('the detected-language label leads with the language, not the marker', () => {
  const localesDirectory = new URL('../../app/locales/', import.meta.url);
  const CommonCatalogSchema = z.object({ search: z.object({ detectedAs: z.string() }) });

  /** `{{language}}` must sit before any other letters, so a 149px truncation still shows it. */
  function assertLanguageLeads(locale: string): void {
    const raw = JSON.parse(readFileSync(new URL(`${locale}/common.json`, localesDirectory), 'utf8'));
    const catalog = CommonCatalogSchema.parse(raw);
    const detectedAs = catalog.search.detectedAs;
    const placeholderIndex = detectedAs.indexOf('{{language}}');
    assert.ok(placeholderIndex >= 0, `${locale}/common.json search.detectedAs has no {{language}} placeholder`);
    // Nothing but whitespace may come before the placeholder: a marker word
    // placed first ("Detect language ({{language}})") is exactly the string
    // that produced the invisible-on-a-phone defect.
    assert.equal(
      detectedAs.slice(0, placeholderIndex).trim(),
      '',
      `${locale}/common.json search.detectedAs must lead with {{language}}, found: ${JSON.stringify(detectedAs)}`,
    );
  }

  it('leads with {{language}} in English', () => {
    assertLanguageLeads('en');
  });

  it('leads with {{language}} in German', () => {
    assertLanguageLeads('de');
  });
});
