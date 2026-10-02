#!/usr/bin/env python3
"""Differential move-generation test against python-chess (pip install chess).
Plays random games (half of them Chess960) and writes every position with its
sorted legal moves; movegen_diff.js then compares the engine against it.
Usage: python3 tools/movegen_diff.py SEED GAMES > positions.txt && bun tools/movegen_diff.js positions.txt"""
import sys, random, chess
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
ngames = int(sys.argv[2]) if len(sys.argv) > 2 else 300
random.seed(seed)
out = sys.stdout
for g in range(ngames):
    c960 = (g % 2 == 1)
    board = chess.Board.from_chess960_pos(random.randrange(960)) if c960 else chess.Board()
    out.write(f"G\t{1 if c960 else 0}\n")
    for ply in range(random.randint(10, 160)):
        legal = list(board.legal_moves)
        out.write(f"P\t{board.fen()}\t{' '.join(sorted(m.uci() for m in legal))}\n")
        if not legal or board.is_insufficient_material() or board.can_claim_fifty_moves():
            break
        caps = [m for m in legal if board.is_capture(m) or m.promotion]
        castles = [m for m in legal if board.is_castling(m)]
        r = random.random()
        mv = random.choice(castles) if castles and r < 0.5 else random.choice(caps) if caps and r < 0.75 else random.choice(legal)
        out.write(f"M\t{mv.uci()}\n")
        board.push(mv)
