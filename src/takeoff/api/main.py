from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from takeoff.api.routes import drawings, takeoff

_STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: nothing needed yet (alembic handles migrations separately)
    yield
    # Shutdown


app = FastAPI(
    title="Takeoff API",
    description="Construction takeoff system — converts CAD-exported PDFs into traceable quantity graphs.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(drawings.router, prefix="/drawings", tags=["drawings"])
app.include_router(takeoff.router, prefix="/takeoff", tags=["takeoff"])

app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def upload_ui():
    """Serve the drag-and-drop PDF upload page."""
    return FileResponse(_STATIC_DIR / "index.html")
