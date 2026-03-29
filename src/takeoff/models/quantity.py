from sqlalchemy import Float, ForeignKey, JSON, String, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship

from takeoff.db import Base


class Quantity(Base):
    """
    The measured amount assigned to a MaterialInstance.
    Quantity belongs to the instance first; it rolls up to the material type at reporting time.
    """

    __tablename__ = "quantities"

    quantity_id: Mapped[str] = mapped_column(String, primary_key=True)
    instance_id: Mapped[str] = mapped_column(ForeignKey("material_instances.instance_id"), unique=True)
    measurement_type: Mapped[str] = mapped_column(String)  # length|area|volume|count|weight
    value: Mapped[float | None] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String)              # LF|SF|CF|EA|LB
    confidence: Mapped[float | None] = mapped_column(Float)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False)
    # Per-stage confidence breakdown
    confidence_breakdown: Mapped[dict | None] = mapped_column(JSON)
    # {"pattern_detection": 0.91, "callout_association": 0.95, "scale": 0.93, "quantity": 0.98}

    instance: Mapped["MaterialInstance"] = relationship(back_populates="quantity")  # type: ignore[name-defined]
