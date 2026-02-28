import { checkToneCompliance } from '../agent.verifier';

describe('checkToneCompliance', () => {
  // ─── True Positives: Should detect violations ─────────────────────

  it('detects pirate speak', () => {
    const result = checkToneCompliance('Arrr, yer portfolio be worth $1,855, matey!');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.confidenceAdjustment).toBeGreaterThan(0);
  });

  it('detects slang terms', () => {
    const result = checkToneCompliance('Yo bruh, your portfolio is lit fam, no cap');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.confidenceAdjustment).toBeGreaterThanOrEqual(0.25);
  });

  it('detects excessive emojis', () => {
    const result = checkToneCompliance(
      'Your portfolio is doing great! \u{1F680}\u{1F4B0}\u{1F525}\u{1F4C8} Keep it up!'
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects sarcasm indicators', () => {
    const result = checkToneCompliance('Suuure, your portfolio is doing "great". Whatever.');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects profanity', () => {
    const result = checkToneCompliance('Your portfolio is doing like shit right now');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects roleplay asterisk markers', () => {
    const result = checkToneCompliance('*adjusts monocle* Your portfolio, good sir...');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects "dude"', () => {
    const result = checkToneCompliance('Dude, your portfolio is killing it!');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects "bro"', () => {
    const result = checkToneCompliance('Bro, you need to diversify');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects "lmao"', () => {
    const result = checkToneCompliance('Your crypto allocation lmao');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects "gonna"', () => {
    const result = checkToneCompliance('This is gonna be a great investment');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  // ─── False Positive Guards: Should NOT trigger ────────────────────

  it('does not trigger on "your"', () => {
    const result = checkToneCompliance('Your portfolio is valued at $10,000.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "familiar"', () => {
    const result = checkToneCompliance('You may be familiar with this asset class.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "family"', () => {
    const result = checkToneCompliance('This ETF is part of the Vanguard family of funds.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "based on"', () => {
    const result = checkToneCompliance('Based on market values, your total is $5,000.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "asset"', () => {
    const result = checkToneCompliance('Your asset allocation is 60% equities.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "broker"', () => {
    const result = checkToneCompliance('Contact your broker for more details.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "browser"', () => {
    const result = checkToneCompliance('Please refresh your browser to see updates.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "suspect"', () => {
    const result = checkToneCompliance('I suspect the price data is outdated.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "sustain"', () => {
    const result = checkToneCompliance('This growth rate may not be sustainable.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on markdown bold (double asterisks)', () => {
    const result = checkToneCompliance('**BUY 10 shares of AAPL** at $185.50/share');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "assess"', () => {
    const result = checkToneCompliance('Let me assess your portfolio performance.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "assign"', () => {
    const result = checkToneCompliance('We can assign a risk category to each holding.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on 1-2 emojis', () => {
    const result = checkToneCompliance('Your portfolio performance: \u{1F4C8}');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on functional status symbols (✓ ✗ ✔ ❌) in professional context', () => {
    const result = checkToneCompliance(
      '**Portfolio Health Check**\n' +
        '**✗** **Diversification**: No holdings to diversify\n' +
        '**✗** **Asset Allocation**: No asset mix established\n' +
        '**✗** **Risk Management**: No positions to manage\n' +
        '**✗** **Performance Tracking**: No investment history'
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.confidenceAdjustment).toBe(0);
  });

  it('does not trigger on normal professional response', () => {
    const result = checkToneCompliance(
      'Your portfolio currently holds 3 positions with a total value of $15,230.50. ' +
      'The allocation is 60% equities, 30% bonds, and 10% cash. ' +
      'Based on market values as of 2026-02-27.'
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.confidenceAdjustment).toBe(0);
  });

  it('does not trigger on "brown"', () => {
    const result = checkToneCompliance('Brown & Company manages this fund.');
    expect(result.warnings).toHaveLength(0);
  });

  it('does not trigger on "broad"', () => {
    const result = checkToneCompliance('A broad market index fund provides diversification.');
    expect(result.warnings).toHaveLength(0);
  });

  // ─── Scaling: confidence penalty increases with violations ────────

  it('applies mild penalty for a single violation', () => {
    const result = checkToneCompliance('This investment is gonna be interesting to watch.');
    expect(result.confidenceAdjustment).toBe(0.15);
  });

  it('applies higher penalty for multiple violations', () => {
    const result = checkToneCompliance(
      'Bruh, this portfolio is gonna be lit fam, no cap'
    );
    expect(result.confidenceAdjustment).toBeGreaterThanOrEqual(0.25);
  });

  it('applies maximum penalty for severe violations', () => {
    const result = checkToneCompliance(
      'Yo bruh, gonna be lit fam, no cap this portfolio is dope lmao'
    );
    expect(result.confidenceAdjustment).toBe(0.35);
  });

  // ─── Warning message format ───────────────────────────────────────

  it('includes category names in warning message', () => {
    const result = checkToneCompliance('Arrr matey, this portfolio gonna be great');
    expect(result.warnings[0]).toContain('unprofessional tone');
    expect(result.warnings[0]).toContain('roleplay');
    expect(result.warnings[0]).toContain('slang');
  });
});
