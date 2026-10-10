"""
Decides which minimap fixes to believe. The minimap is matched on coastline alone, so a look-alike shore can fool it
(on the apron there is almost no coastline at all and it landed 20 nm away several times in a row). Rules, the same as
the companion app's:
  - a fix that agrees with where we believe we are is taken;
  - a parked aircraft cannot jump (more than ~0.25 nm from the last position is refused);
  - a bigger jump is only believed after CONFIRMATIONS agreeing fixes in a row AND a strong match - and a parked
    aircraft needs the same wrong-looking answer to hold for PARKED_HOLD_SECONDS with an even stronger match (a static
    scene repeats the same wrong match every frame, so counting frames alone proves nothing);
  - with no position yet (no stand entered), the first fix must be a strong match.
A stand entry (anchor) sets the position directly.
"""

import math

CONFIRMATIONS = 3
TRUST_SCORE = 0.75
PARKED_KT = 5.0
PARKED_TRUST_SCORE = 0.85
PARKED_HOLD_SECONDS = 60.0


class PositionFilter:
    def __init__(self, trust_score=TRUST_SCORE, confirmations=CONFIRMATIONS):
        self.trust_score = trust_score
        self.confirmations = confirmations
        self.pos = None  # (x_nm, y_nm) in the radar frame
        self.t = None
        self.speed_kt = None
        self._pending = None  # [(x, y), count]

    @property
    def has_position(self):
        return self.pos is not None

    def anchor(self, x_nm, y_nm, now):
        """A known position (the stand): trusted outright, and we are parked."""
        self.pos, self.t, self.speed_kt, self._pending = (x_nm, y_nm), now, 0.0, None

    def _take(self, x, y, now):
        if self.pos is not None and self.t is not None and now - self.t >= 2.0:
            dist = math.hypot(x - self.pos[0], y - self.pos[1])
            speed = dist / ((now - self.t) / 3600.0)
            self.speed_kt = speed if self.speed_kt is None else 0.5 * self.speed_kt + 0.5 * speed
        self.pos, self.t, self._pending = (x, y), now, None

    def accept(self, x_nm, y_nm, score, now):
        """-> (ok, reason). ok means: use this fix as the position."""
        if self.pos is None:
            if score >= self.trust_score:
                self._take(x_nm, y_nm, now)
                return True, "first fix"
            return False, f"first fix too weak ({score * 100:.0f}% match) - enter your stand to start from a known spot"
        moved = math.hypot(x_nm - self.pos[0], y_nm - self.pos[1])
        parked = self.speed_kt is not None and self.speed_kt < PARKED_KT
        since_h = max(0.0, now - self.t) / 3600.0
        allowed = 0.25 if parked else 0.4 + since_h * 400.0
        if moved <= allowed:
            self._take(x_nm, y_nm, now)
            return True, "agrees"
        same = self._pending is not None and math.hypot(x_nm - self._pending[0][0], y_nm - self._pending[0][1]) < 0.3
        self._pending = [(x_nm, y_nm), (self._pending[1] + 1) if same else 1, self._pending[2] if same else now]
        count, first = self._pending[1], self._pending[2]
        need_score = PARKED_TRUST_SCORE if parked else self.trust_score
        held = (now - first) >= PARKED_HOLD_SECONDS if parked else True
        if count >= self.confirmations and score >= need_score and held:
            self._take(x_nm, y_nm, now)
            return True, "jump confirmed"
        return False, (f"ignored: {moved:.1f} nm from where you were, {score * 100:.0f}% match, "
                       f"{count}/{self.confirmations} agreeing" + (", parked" if parked else ""))
