from abc import ABC, abstractmethod


class BaseTransport(ABC):
    @abstractmethod
    def send(self, to: str, text: str) -> None: ...

    @abstractmethod
    def send_media(self, to: str, text: str, media_url: str) -> None: ...
