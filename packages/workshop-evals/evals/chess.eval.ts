import { Chess, DEFAULT_POSITION, type Move as OracleMove, validateFen } from "chess.js";
import { z } from "zod";
import { Seeded } from "./seeded.js";
import { defineTaskEval } from "../src/eval.js";
import { asEvidence, defineEvalTask } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

// A complete chess engine, written from scratch because the Gadget sandbox has no packages, then
// extended twice. Verification is differential: chess.js is the oracle, and the Gadget must agree
// with it on every legal move set, resulting position, and game status it is asked about, on
// curated edge cases and on seeded random games.

const MoveSchema = z.object({
  from: z.string(),
  to: z.string(),
  promotion: z.string().optional(),
});
type Move = z.infer<typeof MoveSchema>;

const FenSchema = z.object({ fen: z.string() });
const MovesSchema = z.object({ moves: z.array(MoveSchema) });
const LoadSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
const MoveResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), fen: z.string() }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
const LoadPgnSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), fen: z.string() }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
const PgnSchema = z.object({ pgn: z.string() });

const StatusSchema = z.object({
  turn: z.enum(["w", "b"]),
  inCheck: z.boolean(),
  checkmate: z.boolean(),
  stalemate: z.boolean(),
  gameOver: z.boolean(),
  threefoldRepetition: z.boolean().optional(),
  fiftyMoveRule: z.boolean().optional(),
  insufficientMaterial: z.boolean().optional(),
  draw: z.boolean().optional(),
});
type Status = z.infer<typeof StatusSchema>;

interface ChessApi {
  newGame(): Promise<z.infer<typeof FenSchema>>;
  loadFen(input: { fen: string }): Promise<z.infer<typeof LoadSchema>>;
  fen(): Promise<z.infer<typeof FenSchema>>;
  legalMoves(): Promise<z.infer<typeof MovesSchema>>;
  move(move: Move): Promise<z.infer<typeof MoveResultSchema>>;
  status(): Promise<Status>;
  loadPgn(input: { pgn: string }): Promise<z.infer<typeof LoadPgnSchema>>;
  pgn(): Promise<z.infer<typeof PgnSchema>>;
}

const TITLE = "Chess";

function moveKey(move: Move): string {
  return `${move.from}${move.to}${move.promotion?.toLowerCase() ?? ""}`.toLowerCase();
}

function oracleMoves(oracle: Chess): string[] {
  return oracle.moves({ verbose: true }).map(move => moveKey(move)).toSorted();
}

async function gadgetMoves(api: ChessApi): Promise<string[]> {
  return MovesSchema.parse(await api.legalMoves()).moves.map(moveKey).toSorted();
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * FEN as the oracle would write the same position. Two conventions exist for the en passant
 * field (after every double push, or only when a capture is actually possible) and the oracle
 * uses the second; comparing through it accepts both. An unparseable FEN stays as written.
 */
function canonical(fen: string): string {
  return validateFen(fen).ok ? new Chess(fen).fen() : fen;
}

function sameFen(left: string, right: string): boolean {
  return canonical(left) === canonical(right);
}

/**
 * The oracle's status as the turn under test defines it. Until turn 3 adds draw detection,
 * `gameOver` means checkmate or stalemate only: a position drawn by material after, say, a
 * promotion to a knight is not over yet in turns 1 and 2.
 */
function oracleStatus(oracle: Chess, fields: readonly (keyof Status)[]): Status {
  const drawsCount = fields.includes("draw");
  return {
    turn: oracle.turn(),
    inCheck: oracle.isCheck(),
    checkmate: oracle.isCheckmate(),
    stalemate: oracle.isStalemate(),
    gameOver: drawsCount ? oracle.isGameOver() : oracle.isCheckmate() || oracle.isStalemate(),
    threefoldRepetition: oracle.isThreefoldRepetition(),
    fiftyMoveRule: oracle.isDrawByFiftyMoves(),
    insufficientMaterial: oracle.isInsufficientMaterial(),
    draw: oracle.isDraw(),
  };
}

const BASE_STATUS = ["turn", "inCheck", "checkmate", "stalemate", "gameOver"] as const;
const DRAW_STATUS = [...BASE_STATUS, "threefoldRepetition", "fiftyMoveRule",
  "insufficientMaterial", "draw"] as const;

function statusMismatch(
    actual: Status, expected: Status, fields: readonly (keyof Status)[]): string[] {
  return fields.filter(field => actual[field] !== expected[field]);
}

type Divergence = { at: string; what: string; gadget: unknown; oracle: unknown };

/**
 * Compare the stored position, legal moves and status with the oracle at the Gadget's current
 * position. A drawn game can still have movable pieces, and engines differ on whether to list
 * them once play is over; either answer is accepted there. Until turn 3 defines draws, only a
 * dead position (insufficient material) ends play by itself, as it does over the board.
 */
async function compareHere(
    api: ChessApi, oracle: Chess, fields: readonly (keyof Status)[]): Promise<Divergence | null> {
  const fen = oracle.fen();
  const stored = FenSchema.parse(await api.fen()).fen;
  if (!sameFen(stored, fen)) return { at: fen, what: "fen", gadget: stored, oracle: fen };
  const [moves, status] = [await gadgetMoves(api), StatusSchema.parse(await api.status())];
  const expectedMoves = oracleMoves(oracle);
  const drawnWithMovesLeft = fields.includes("draw")
    ? oracle.isGameOver() && !oracle.isCheckmate() && !oracle.isStalemate()
    : oracle.isInsufficientMaterial();
  if (!sameList(moves, expectedMoves) && !(drawnWithMovesLeft && moves.length === 0)) {
    return { at: fen, what: "legalMoves", gadget: moves, oracle: expectedMoves };
  }
  const expected = oracleStatus(oracle, fields);
  const mismatch = statusMismatch(status, expected, fields);
  if (mismatch.length > 0) {
    return { at: fen, what: `status.${mismatch.join(",")}`, gadget: status, oracle: expected };
  }
  return null;
}

/**
 * The Gadget's own record of the game, without tag pairs: the prompt asks for movetext, and a
 * Gadget that also writes a Date or clock tag must not fail "changes nothing" on that.
 */
async function movetext(api: ChessApi): Promise<string> {
  return PgnSchema.parse(await api.pgn()).pgn.replace(/^\[[^\]]*\]\s*$/gm, "").trim();
}

/** Every malformed FEN is refused with INVALID_FEN and leaves the stored position as it was. */
async function refusesInvalidFens(api: ChessApi, position: string) {
  const refusals = [];
  for (const fen of INVALID_FENS) {
    const refused = LoadSchema.parse(await api.loadFen({ fen }));
    const after = FenSchema.parse(await api.fen()).fen;
    refusals.push({ fen, refused, unchanged: sameFen(after, position) });
  }
  const ok = refusals.every(({ refused, unchanged }) =>
    !refused.ok && refused.error === "INVALID_FEN" && unchanged);
  return { ok, refusals };
}

type GameOptions = {
  plies: number;
  fields: readonly (keyof Status)[];
  /** Once turn 2 adds PGN, a refused move must leave the game's own record unchanged too. */
  pgn: boolean;
};

/**
 * Play a seeded random game on both engines, comparing legal moves, status, and the position after
 * every move. Every few plies, also try moves the oracle says are illegal and require that they are
 * refused without changing the position, or the recorded game once there is one.
 */
async function differentialGame(
    api: ChessApi, seed: number, { plies, fields, pgn }: GameOptions): Promise<Divergence | null> {
  const random = new Seeded(seed);
  const oracle = new Chess();
  const record = async () => pgn ? await movetext(api) : null;
  await api.newGame();
  for (let ply = 0; ply < plies && !oracle.isGameOver(); ply++) {
    const divergence = await compareHere(api, oracle, fields);
    if (divergence !== null) return divergence;
    const legal = oracle.moves({ verbose: true });
    if (ply % 5 === 0) {
      const legalKeys = new Set(legal.map(move => moveKey(move)));
      for (let attempt = 0; attempt < 3; attempt++) {
        const from = random.pick(legal).from;
        const to = `${"abcdefgh"[random.int(0, 7)]}${random.int(1, 8)}`;
        if (legalKeys.has(`${from}${to}`) || legalKeys.has(`${from}${to}q`)) continue;
        const before = await record();
        const refused = MoveResultSchema.parse(await api.move({ from, to }));
        const after = FenSchema.parse(await api.fen()).fen;
        const afterRecord = await record();
        if (refused.ok || refused.error !== "ILLEGAL_MOVE" || !sameFen(after, oracle.fen()) ||
            afterRecord !== before) {
          return { at: oracle.fen(), what: `illegal ${from}${to}`,
            gadget: { refused, after, pgn: { before, after: afterRecord } }, oracle: "ILLEGAL_MOVE" };
        }
      }
    }
    const chosen = random.pick(legal);
    const played = MoveResultSchema.parse(await api.move({
      from: chosen.from, to: chosen.to,
      ...(chosen.promotion === undefined ? {} : { promotion: chosen.promotion }),
    }));
    oracle.move(chosen);
    if (!played.ok || !sameFen(played.fen, oracle.fen())) {
      return { at: oracle.fen(), what: `after ${chosen.san}`, gadget: played, oracle: oracle.fen() };
    }
  }
  return await compareHere(api, oracle, fields);
}

// Special moves for both colours: an engine that only castles or captures en passant as White
// would otherwise pass every position here.
const CURATED: Record<string, string> = {
  bothCastles: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1",
  blackBothCastles: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1",
  castleThroughCheck: "4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1",
  castleRightsPartlyLost: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w Kq - 0 1",
  enPassantAvailable: "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
  blackEnPassant: "rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 3",
  enPassantExposesKing: "8/8/8/8/k2pP2R/8/8/4K3 b - e3 0 1",
  promotion: "8/P7/8/8/8/8/8/k6K w - - 0 1",
  promotionByCapture: "1n6/P7/8/8/8/8/8/k6K w - - 0 1",
  blackPromotion: "k6K/8/8/8/8/8/p7/8 b - - 0 1",
  pinnedBishop: "4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1",
  inCheck: "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
  checkmate: "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4",
  stalemate: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
  middlegame: "r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PP2BPPP/R2QKB1R w KQ - 0 9",
};

// Six-field FENs that a parser must inspect, not just count, to refuse.
const INVALID_FENS = [
  "not a position",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1",
  "rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e9 0 1",
];

async function checkCurated(
    verifier: EvalVerifier, id: string, fields: readonly (keyof Status)[],
    positions: Record<string, string>): Promise<void> {
  await verifier.check(id, async () => {
    using api = await verifier.connect<ChessApi>(TITLE);
    const failures: Record<string, unknown> = {};
    for (const [name, fen] of Object.entries(positions)) {
      const loaded = LoadSchema.parse(await api.loadFen({ fen }));
      if (!loaded.ok) {
        failures[name] = { what: "loadFen", gadget: loaded };
        continue;
      }
      const roundTrip = FenSchema.parse(await api.fen()).fen;
      if (!sameFen(roundTrip, fen)) {
        failures[name] = { what: "fen round trip", gadget: roundTrip, oracle: fen };
        continue;
      }
      const divergence = await compareHere(api, new Chess(fen), fields);
      if (divergence !== null) {
        failures[name] = divergence;
        continue;
      }
      const played = await playSpecialMoves(api, fen, fields);
      if (played !== null) failures[name] = played;
    }
    return { pass: Object.keys(failures).length === 0, evidence: asEvidence(failures) };
  });
}

/**
 * Listing a castle, en passant capture or promotion correctly is not applying it correctly: play
 * each one the position offers and compare the resulting position with the oracle's.
 */
async function playSpecialMoves(
    api: ChessApi, fen: string, fields: readonly (keyof Status)[]): Promise<Divergence | null> {
  const oracle = new Chess(fen);
  const special = oracle.moves({ verbose: true }).filter(move =>
    move.isKingsideCastle() || move.isQueensideCastle() || move.isEnPassant() || move.isPromotion());
  for (const move of special) {
    await api.loadFen({ fen });
    const played = MoveResultSchema.parse(await api.move({
      from: move.from, to: move.to,
      ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
    }));
    const expected = new Chess(fen);
    expected.move(move);
    if (!played.ok || !sameFen(played.fen, expected.fen())) {
      return { at: fen, what: `after ${move.san}`, gadget: played, oracle: expected.fen() };
    }
    const divergence = await compareHere(api, expected, fields);
    if (divergence !== null) return { ...divergence, what: `${divergence.what} after ${move.san}` };
  }
  return null;
}

async function checkGames(
    verifier: EvalVerifier, id: string, seeds: readonly number[],
    options: GameOptions): Promise<void> {
  await verifier.check(id, async () => {
    using api = await verifier.connect<ChessApi>(TITLE);
    for (const seed of seeds) {
      const divergence = await differentialGame(api, seed, options);
      if (divergence !== null) {
        return { pass: false, evidence: asEvidence({ seed, ...divergence }) };
      }
    }
    return { pass: true, evidence: asEvidence({ seeds, ...options }) };
  });
}

/** A seeded random game as PGN, so import covers whatever castling, captures and checks it has. */
function randomPgn(seed: number, plies: number): string {
  const random = new Seeded(seed);
  const oracle = new Chess();
  for (let ply = 0; ply < plies && !oracle.isGameOver(); ply++) {
    oracle.move(random.pick(oracle.moves({ verbose: true })));
  }
  return oracle.pgn();
}

const PGN_GAMES: Record<string, string> = {
  foolsMate: "1. f3 e5 2. g4 Qh4#",
  blackWins: "1. f3 e5 2. g4 Qh4# 0-1",
  // Sam Loyd's ten-move stalemate.
  stalemate: "1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. h4 Rah6 5. Qxc7 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 " +
    "8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6 1/2-1/2",
  scholarsMate: "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
  legalTrap: "1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#",
  operaGame: `[Event "Paris"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`,
  randomA: randomPgn(7, 60),
  randomB: randomPgn(11, 80),
};

const INVALID_PGNS = [
  "1. e4 e5 2. Ke2 Ke7 3. Ke1 Kxe1",
  "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O-O",
  "this is not a game",
];

const task = defineEvalTask({
  id: "chess",
  turns: [{
    prompt: `Build a Gadget named exactly "${TITLE}": a two-player chess game a friend and I can both
open on our phones and play in real time. Full rules of play: castling (including that you cannot
castle out of, through, or into check), en passant, promotion, check, checkmate and stalemate.
The Gadget sandbox has no packages, so implement the rules yourself. Keep the game in the Gadget's
own storage.

Squares are algebraic ("e2"); promotion pieces are "q", "r", "b" or "n"; FEN is the full six-field
form, including castling rights, en passant square, halfmove clock and move number. For the en
passant field, recording the square after every double pawn push or only when a capture is
actually possible are both fine.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- newGame() -> { fen }   the standard starting position
- loadFen({ fen }) -> { ok: true } | { ok: false, error: "INVALID_FEN" }   replaces the position
- fen() -> { fen }
- legalMoves() -> { moves: Array<{ from, to, promotion? }> }   every legal move and nothing else
- move({ from, to, promotion? }) -> { ok: true, fen } | { ok: false, error: "ILLEGAL_MOVE" }
  A refused move changes nothing.
- status() -> { turn: "w" | "b", inCheck, checkmate, stalemate, gameOver }`,
    verify: async verifier => {
      await verifier.check("starts-from-the-standard-position", async () => {
        using api = await verifier.connect<ChessApi>(TITLE);
        const started = FenSchema.parse(await api.newGame()).fen;
        const read = FenSchema.parse(await api.fen()).fen;
        const status = StatusSchema.parse(await api.status());
        const moves = await gadgetMoves(api);
        const refusals = await refusesInvalidFens(api, DEFAULT_POSITION);
        return {
          pass: started === DEFAULT_POSITION && read === DEFAULT_POSITION &&
            statusMismatch(status, oracleStatus(new Chess(), BASE_STATUS), BASE_STATUS).length === 0 &&
            sameList(moves, oracleMoves(new Chess())) && refusals.ok,
          evidence: { started, status, moveCount: moves.length, refusals: refusals.refusals },
        };
      });
      await checkCurated(verifier, "agrees-with-the-oracle-on-the-hard-positions", BASE_STATUS, CURATED);
      await checkGames(verifier, "agrees-with-the-oracle-through-random-games", [1, 2],
          { plies: 60, fields: BASE_STATUS, pgn: false });

      // Two phones share one game: a position reached over one connection must be what the next
      // connection sees, which a per-connection or in-memory game does not give.
      await verifier.check("the-game-is-shared-across-connections", async () => {
        const oracle = new Chess();
        {
          using first = await verifier.connect<ChessApi>(TITLE);
          await first.newGame();
          for (const san of ["e4", "c5", "Nf3"]) {
            const move = oracle.move(san);
            await first.move({ from: move.from, to: move.to });
          }
        }
        using second = await verifier.connect<ChessApi>(TITLE);
        const fen = FenSchema.parse(await second.fen()).fen;
        const moves = await gadgetMoves(second);
        return {
          pass: sameFen(fen, oracle.fen()) && sameList(moves, oracleMoves(oracle)),
          evidence: { fen, expected: oracle.fen() },
        };
      });
    },
  }, {
    prompt: `Add PGN so we can load games from Lichess and share ours.

- loadPgn({ pgn }) -> { ok: true, fen } | { ok: false, error: "INVALID_PGN" }
  Plays the game from the standard start. Movetext in standard algebraic notation with move
  numbers; tag pairs before it and a result at the end are both optional. A PGN with an illegal
  move is refused and changes nothing.
- pgn() -> { pgn }   the moves of the current game in standard algebraic notation with move
  numbers, and the result at the end once the game is over.

Everything that already worked keeps working.`,
    verify: async verifier => {
      await verifier.check("imports-known-games-to-the-right-positions", async () => {
        using api = await verifier.connect<ChessApi>(TITLE);
        const failures: Record<string, unknown> = {};
        for (const [name, pgn] of Object.entries(PGN_GAMES)) {
          const oracle = new Chess();
          oracle.loadPgn(pgn);
          const loaded = LoadPgnSchema.parse(await api.loadPgn({ pgn }));
          const fen = FenSchema.parse(await api.fen()).fen;
          if (!loaded.ok || !sameFen(loaded.fen, oracle.fen()) || !sameFen(fen, oracle.fen())) {
            failures[name] = { loaded, fen, oracle: oracle.fen() };
            continue;
          }
          const divergence = await compareHere(api, oracle, BASE_STATUS);
          if (divergence !== null) failures[name] = divergence;
        }
        return { pass: Object.keys(failures).length === 0, evidence: asEvidence(failures) };
      });

      await verifier.check("refuses-invalid-pgn-without-changing-the-game", async () => {
        using api = await verifier.connect<ChessApi>(TITLE);
        const before = LoadPgnSchema.parse(await api.loadPgn({ pgn: PGN_GAMES.legalTrap ?? "" }));
        const beforePgn = await movetext(api);
        const results = [];
        for (const pgn of INVALID_PGNS) {
          const refused = LoadPgnSchema.parse(await api.loadPgn({ pgn }));
          const after = FenSchema.parse(await api.fen()).fen;
          const afterPgn = await movetext(api);
          results.push({ refused, unchanged: before.ok && sameFen(after, before.fen) && afterPgn === beforePgn });
        }
        return {
          pass: before.ok && results.every(result =>
            !result.refused.ok && result.refused.error === "INVALID_PGN" && result.unchanged),
          evidence: { before, results },
        };
      });

      await verifier.check("exports-pgn-the-oracle-replays-to-the-same-position", async () => {
        using api = await verifier.connect<ChessApi>(TITLE);
        const failures: Record<string, unknown> = {};
        // An imported game, and a game played move by move, both exported.
        const cases: Record<string, () => Promise<Chess>> = {
          imported: async () => {
            const oracle = new Chess();
            oracle.loadPgn(PGN_GAMES.operaGame ?? "");
            await api.loadPgn({ pgn: PGN_GAMES.operaGame ?? "" });
            return oracle;
          },
          played: async () => {
            const random = new Seeded(23);
            const oracle = new Chess();
            await api.newGame();
            for (let ply = 0; ply < 40 && !oracle.isGameOver(); ply++) {
              const chosen = random.pick(oracle.moves({ verbose: true }));
              await api.move({ from: chosen.from, to: chosen.to,
                ...(chosen.promotion === undefined ? {} : { promotion: chosen.promotion }) });
              oracle.move(chosen);
            }
            return oracle;
          },
        };
        for (const [name, setUp] of Object.entries(cases)) {
          const oracle = await setUp();
          const exported = PgnSchema.parse(await api.pgn()).pgn;
          const replay = new Chess();
          try {
            replay.loadPgn(exported);
          } catch (error) {
            failures[name] = { exported, error: error instanceof Error ? error.message : String(error) };
            continue;
          }
          // The replay's own canonical SAN of what it parsed, against the game actually played.
          if (!sameList(replay.history(), oracle.history())) {
            failures[name] = { exported, replayed: replay.history(), played: oracle.history() };
          } else if (!sameFen(replay.fen(), oracle.fen())) {
            failures[name] = { exported, replayedTo: replay.fen(), playedTo: oracle.fen() };
          } else if (oracle.isGameOver() && !/(1-0|0-1|1\/2-1\/2)\s*$/.test(exported.trim())) {
            failures[name] = { exported, what: "missing result" };
          }
        }
        return { pass: Object.keys(failures).length === 0, evidence: asEvidence(failures) };
      });

      await checkGames(verifier, "rules-still-agree-with-the-oracle", [3],
          { plies: 50, fields: BASE_STATUS, pgn: true });
    },
  }, {
    prompt: `Add draw detection to status(): threefoldRepetition, fiftyMoveRule and
insufficientMaterial as booleans, plus draw, which is true for any of those or for stalemate.
gameOver is true for checkmate or draw. Everything that already worked keeps working.`,
    verify: async verifier => {
      await verifier.check("detects-threefold-repetition-and-the-fifty-move-rule", async () => {
        using api = await verifier.connect<ChessApi>(TITLE);
        const oracle = new Chess();
        await api.newGame();
        const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
        const seen: Status[] = [];
        const played: z.infer<typeof MoveResultSchema>[] = [];
        for (let repeat = 0; repeat < 2; repeat++) {
          for (const key of shuffle) {
            const move = { from: key.slice(0, 2), to: key.slice(2) };
            played.push(MoveResultSchema.parse(await api.move(move)));
            oracle.move(move);
          }
          seen.push(StatusSchema.parse(await api.status()));
        }
        const afterTwo = seen[0];
        const afterThree = seen[1];
        // The start position has now occurred three times; loading it again begins a new game.
        const reloaded = LoadSchema.parse(await api.loadFen({ fen: new Chess().fen() }));
        const afterReload = StatusSchema.parse(await api.status());
        const fiftyFen = "8/8/8/8/8/4k3/8/R3K3 w - - 99 80";
        const fiftyOracle = new Chess(fiftyFen);
        const loadedFifty = LoadSchema.parse(await api.loadFen({ fen: fiftyFen }));
        const beforeFifty = StatusSchema.parse(await api.status());
        const expectedBeforeFifty = oracleStatus(fiftyOracle, DRAW_STATUS);
        played.push(MoveResultSchema.parse(await api.move({ from: "a1", to: "a2" })));
        fiftyOracle.move({ from: "a1", to: "a2" });
        const afterFifty = StatusSchema.parse(await api.status());
        const expectedThree = oracleStatus(oracle, DRAW_STATUS);
        return {
          pass: afterTwo !== undefined && afterThree !== undefined && reloaded.ok && loadedFifty.ok &&
            afterReload.threefoldRepetition === false && afterReload.draw === false &&
            played.every(result => result.ok) &&
            afterTwo.threefoldRepetition === false && afterTwo.draw === false &&
            statusMismatch(afterThree, expectedThree, DRAW_STATUS).length === 0 &&
            expectedThree.threefoldRepetition === true &&
            statusMismatch(beforeFifty, expectedBeforeFifty, DRAW_STATUS).length === 0 &&
            statusMismatch(afterFifty, oracleStatus(fiftyOracle, DRAW_STATUS), DRAW_STATUS).length === 0 &&
            afterFifty.fiftyMoveRule === true && afterFifty.gameOver === true,
          evidence: { played, afterTwo, afterThree, expectedThree, afterReload, loadedFifty,
            beforeFifty, afterFifty },
        };
      });

      await verifier.check("still-refuses-invalid-fen", async () => {
        using api = await verifier.connect<ChessApi>(TITLE);
        await api.newGame();
        const refusals = await refusesInvalidFens(api, DEFAULT_POSITION);
        return { pass: refusals.ok, evidence: { refusals: refusals.refusals } };
      });

      // Reached by play rather than loaded: the capture leaves king and knight against king.
      await verifier.check("detects-insufficient-material-after-a-capture", async () => {
        using api = await verifier.connect<ChessApi>(TITLE);
        const start = "4k3/8/8/8/8/8/3p4/4K2N w - - 0 1";
        const oracle = new Chess(start);
        const loaded = LoadSchema.parse(await api.loadFen({ fen: start }));
        const played = MoveResultSchema.parse(await api.move({ from: "e1", to: "d2" }));
        oracle.move({ from: "e1", to: "d2" });
        const divergence = await compareHere(api, oracle, DRAW_STATUS);
        return {
          pass: loaded.ok && played.ok && divergence === null,
          evidence: asEvidence({ loaded, played, divergence }),
        };
      });

      await checkCurated(verifier, "judges-material-and-terminal-positions-like-the-oracle", DRAW_STATUS, {
        knightVersusKing: "8/8/8/8/8/4k3/8/4K2N w - - 0 1",
        bishopVersusKing: "8/8/8/8/8/4k3/8/4K2B w - - 0 1",
        rookVersusKing: "8/8/8/8/8/4k3/8/4K2R w - - 0 1",
        sameColourBishops: "8/8/8/8/8/3bk3/8/4K2B w - - 0 1",
        kingsOnly: "8/8/8/8/8/4k3/8/4K3 w - - 0 1",
        checkmate: CURATED.checkmate ?? "",
        stalemate: CURATED.stalemate ?? "",
        middlegame: CURATED.middlegame ?? "",
      });

      await checkGames(verifier, "rules-still-agree-with-the-oracle-after-draws", [4],
          { plies: 50, fields: DRAW_STATUS, pgn: true });
    },
  }],
});

// The oracle must accept every PGN the task calls valid and refuse every one it calls invalid.
for (const [name, pgn] of Object.entries(PGN_GAMES)) {
  try {
    new Chess().loadPgn(pgn);
  } catch (error) {
    throw new Error(`PGN_GAMES.${name} is not a valid game`, { cause: error });
  }
}
for (const pgn of INVALID_PGNS) {
  let accepted = true;
  try {
    new Chess().loadPgn(pgn);
  } catch {
    accepted = false;
  }
  if (accepted) throw new Error(`INVALID_PGNS entry is accepted by the oracle: ${pgn}`);
}
for (const [name, fen] of Object.entries(CURATED)) {
  if (!validateFen(fen).ok) throw new Error(`CURATED.${name} is not a valid FEN`);
}
for (const fen of INVALID_FENS) {
  if (validateFen(fen).ok) throw new Error(`INVALID_FENS entry is accepted by the oracle: ${fen}`);
}
// A Black fixture is only worth its name if the oracle offers the move it exists for.
const BLACK_FIXTURES: Record<string, (move: OracleMove) => boolean> = {
  blackBothCastles: move => move.isKingsideCastle() || move.isQueensideCastle(),
  blackEnPassant: move => move.isEnPassant(),
  blackPromotion: move => move.isPromotion(),
};
for (const [name, offers] of Object.entries(BLACK_FIXTURES)) {
  const fen = CURATED[name];
  if (fen === undefined || !new Chess(fen).moves({ verbose: true }).some(offers)) {
    throw new Error(`CURATED.${name} does not offer the move it is named for`);
  }
}

defineTaskEval(task);
