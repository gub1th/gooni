from fastapi import APIRouter


router = APIRouter()


@router.get("/healthz")
async def root():
    return {"message": "ok"}
