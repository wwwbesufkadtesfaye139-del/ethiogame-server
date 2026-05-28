/**
 * BingoVerifier — Server-Side Win Verification
 *
 * All verification is performed against the server's authoritative copy of:
 *   - The player's card (generated on the server, never trusted from client)
 *   - The list of called numbers (maintained on the server)
 *
 * A standard Bingo card is a 5×5 grid:
 *   Columns → B(1-15), I(16-30), N(31-45), G(46-60), O(61-75)
 *   Center cell (row 2, col 2) is a FREE space (value = 0)
 *
 * Win patterns checked: any row, any column, or either diagonal.
 */

const BINGO_COLUMNS = {
  B: { min: 1,  max: 15 },
  I: { min: 16, max: 30 },
  N: { min: 31, max: 45 },
  G: { min: 46, max: 60 },
  O: { min: 61, max: 75 },
};
const FREE_SPACE = 0;
const CARD_SIZE = 5;

/**
 * Generates a random Bingo card on the server.
 * Returns a 5×5 2D array (rows × columns).
 * Center cell is FREE_SPACE (0).
 *
 * @returns {number[][]}
 */
const generateBingoCard = () => {
  const columns = Object.values(BINGO_COLUMNS);
  const card = [];

  // Build column arrays
  const columnArrays = columns.map(({ min, max }) => {
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);
    return shuffleArray(pool).slice(0, CARD_SIZE);
  });

  // Transpose to row-major order
  for (let row = 0; row < CARD_SIZE; row++) {
    card.push(columnArrays.map((col) => col[row]));
  }

  // Set center cell to FREE
  card[2][2] = FREE_SPACE;
  return card;
};

/**
 * Generates the full 75-number draw pool and shuffles it.
 * The server draws from this pool sequentially.
 *
 * @returns {number[]}
 */
const generateDrawPool = () => {
  const pool = [];
  for (let n = 1; n <= 75; n++) pool.push(n);
  return shuffleArray(pool);
};

/**
 * Verifies a Bingo win claim.
 *
 * @param {number[][]} card          - 5×5 card (server-authoritative)
 * @param {number[]}   calledNumbers - all numbers drawn so far (server-authoritative)
 * @returns {{ isWinner: boolean, pattern: string|null }}
 */
const verifyBingoWin = (card, calledNumbers) => {
  const calledSet = new Set(calledNumbers);
  calledSet.add(FREE_SPACE); // FREE space is always "called"

  const isMarked = (row, col) => calledSet.has(card[row][col]);

  // Check each row
  for (let row = 0; row < CARD_SIZE; row++) {
    if (rowComplete(card, row, calledSet)) {
      return { isWinner: true, pattern: `row_${row}` };
    }
  }

  // Check each column
  for (let col = 0; col < CARD_SIZE; col++) {
    if (columnComplete(card, col, calledSet)) {
      return { isWinner: true, pattern: `col_${col}` };
    }
  }

  // Check top-left → bottom-right diagonal
  const diag1 = [0, 1, 2, 3, 4].every((i) => isMarked(i, i));
  if (diag1) return { isWinner: true, pattern: 'diagonal_TL_BR' };

  // Check top-right → bottom-left diagonal
  const diag2 = [0, 1, 2, 3, 4].every((i) => isMarked(i, CARD_SIZE - 1 - i));
  if (diag2) return { isWinner: true, pattern: 'diagonal_TR_BL' };

  return { isWinner: false, pattern: null };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const rowComplete = (card, row, calledSet) =>
  card[row].every((cell) => calledSet.has(cell));

const columnComplete = (card, col, calledSet) =>
  card.every((row) => calledSet.has(row[col]));

const shuffleArray = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

module.exports = { generateBingoCard, generateDrawPool, verifyBingoWin, FREE_SPACE };
