from dotenv import load_dotenv
load_dotenv()

from app.db.database import engine
from app.db.models import Base

# Create all tables
Base.metadata.create_all(bind=engine)
print("Database tables created successfully!")