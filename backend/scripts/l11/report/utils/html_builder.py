"""Utility class for building HTML elements used in PDF reports."""

from typing import Optional


class Html:
    """Utility class for constructing HTML elements for reportlab Paragraphs."""
    
    @staticmethod
    def anchor(name: str) -> str:
        """Create an HTML anchor element.
        
        Args:
            name: The anchor name (for linking with href)
            
        Returns:
            HTML anchor string
        """
        return f'<a name="{name}"/>'
    
    @staticmethod
    def link(href: str, text: str, color: Optional[str] = None) -> str:
        """Create an HTML link element.
        
        Args:
            href: The link target (anchor name or URL)
            text: The link display text (can include bullet prefix)
            color: Optional color for the text
            
        Returns:
            HTML link string
        """
        if color:
            colored_text = Html.font(text, color=color)
            return f'<a href="{href}" color="{color}">{colored_text}</a>'
        return f'<a href="{href}">{text}</a>'
    
    @staticmethod
    def bold(text: str) -> str:
        """Create bold text.
        
        Args:
            text: The text to make bold
            
        Returns:
            HTML bold string
        """
        return f'<b>{text}</b>'
    
    @staticmethod
    def italic(text: str) -> str:
        """Create italic text.
        
        Args:
            text: The text to make italic
            
        Returns:
            HTML italic string
        """
        return f'<i>{text}</i>'
    
    @staticmethod
    def underline(text: str) -> str:
        """Create underlined text.
        
        Args:
            text: The text to underline
            
        Returns:
            HTML underline string
        """
        return f'<u>{text}</u>'
    
    @staticmethod
    def font(text: str, color: Optional[str] = None, size: Optional[int] = None) -> str:
        """Create text with font styling.
        
        Args:
            text: The text to style
            color: Font color (e.g., 'red', 'blue', '#FF0000')
            size: Font size in points
            
        Returns:
            HTML font string
        """
        attrs = []
        if color:
            attrs.append(f'color="{color}"')
        if size:
            attrs.append(f'size="{size}"')
        
        if attrs:
            attr_str = ' ' + ' '.join(attrs)
            return f'<font{attr_str}>{text}</font>'
        return text
    
    @staticmethod
    def break_line() -> str:
        """Create a line break.
        
        Returns:
            HTML line break string
        """
        return '<br/>'
    
    @staticmethod
    def colored_text(text: str, color: str) -> str:
        """Create colored text (convenience method).
        
        Args:
            text: The text to color
            color: The color name or hex value
            
        Returns:
            HTML colored text string
        """
        return Html.font(text, color=color)
    
    @staticmethod
    def bold_colored(text: str, color: str) -> str:
        """Create bold colored text (convenience method).
        
        Args:
            text: The text to style
            color: The color name or hex value
            
        Returns:
            HTML bold colored text string
        """
        return Html.bold(Html.font(text, color=color))
    
    @staticmethod
    def replace_spaces_with_breaks(text: str) -> str:
        """Replace spaces with line breaks.
        
        Args:
            text: Text with spaces
            
        Returns:
            Text with <br/> instead of spaces
        """
        return text.replace(' ', '<br/>')
