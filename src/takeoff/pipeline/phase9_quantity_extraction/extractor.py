"""
Phase 9: Quantity Extraction Per Instance.

Measures each MaterialInstance using the correct basis and unit.
All math is deterministic — no AI.

Measurement types supported (MVP: length only):
- length  → polyline length × scale_ratio → real inches → convert to LF
- area    → polygon area × scale_ratio² → SF  (future)
- volume  → area × depth → CF           (future)
- count   → 1 per instance              (future, for columns/footings)
- weight  → LF × lbs_per_ft from catalog (future)

Formula (length):
  pdf_length (pts) × scale_ratio (in/pt) / 12 = real feet (LF)
"""

from __future__ import annotations

import math
import uuid

from sqlalchemy.orm import Session, joinedload

from takeoff.models.drawing import Drawing, View
from takeoff.models.material import MaterialInstance
from takeoff.models.quantity import Quantity


class QuantityExtractor:
    def __init__(self, db: Session) -> None:
        self.db = db

    def extract(self, drawing: Drawing) -> list[Quantity]:
        """
        For each MaterialInstance in the drawing, compute its quantity
        and persist a Quantity record.
        """
        # Query all MaterialInstances for the drawing's views
        instances = (
            self.db.query(MaterialInstance)
            .join(View)
            .filter(View.drawing_id == drawing.drawing_id)
            .options(joinedload(MaterialInstance.quantity), joinedload(MaterialInstance.view))
            .all()
        )
        
        quantities = []
        for instance in instances:
            if instance.quantity is not None:
                # Already has quantity
                continue
            
            view = instance.view  # Assuming loaded via join
            scale_ratio = view.scale_ratio
            scale_confidence = view.scale_confidence or 0.0
            
            if scale_ratio is None or scale_confidence < 0.5:
                # Scale uncertain, mark low confidence
                confidence = 0.1
                value = None
                needs_review = True
            else:
                # Compute quantity
                length_pts = self.polyline_length(instance.geometry)
                value = length_pts * scale_ratio / 12  # LF
                confidence = scale_confidence  # For now, just scale
                needs_review = False
            
            # For MVP, assume length
            measurement_type = "length"
            unit = "LF"
            
            confidence_breakdown = {
                "scale": scale_confidence,
                "quantity": 1.0 if not needs_review else 0.1
            }
            
            quantity = Quantity(
                quantity_id=str(uuid.uuid4()),
                instance_id=instance.instance_id,
                measurement_type=measurement_type,
                value=value,
                unit=unit,
                confidence=confidence,
                needs_review=needs_review,
                confidence_breakdown=confidence_breakdown
            )
            
            self.db.add(quantity)
            quantities.append(quantity)
        
        self.db.commit()
        return quantities

    @staticmethod
    def polyline_length(geometry: dict) -> float:
        """
        Calculate the total length of a polyline geometry in PDF user units.
        geometry = {"kind": "line"/"polyline", "points": [[x1,y1], [x2,y2], ...]}
        """
        points = geometry.get("points", [])
        if len(points) < 2:
            return 0.0
        total = 0.0
        for i in range(len(points) - 1):
            dx = points[i + 1][0] - points[i][0]
            dy = points[i + 1][1] - points[i][1]
            total += math.sqrt(dx * dx + dy * dy)
        return total
