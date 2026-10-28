"""Utility for applying watermarks to PDF files."""

import os
import sys
import math
import tempfile
import argparse
from reportlab.pdfgen import canvas as pdf_canvas


def create_watermark_pdf(watermark_path: str, width: float, height: float, text: str = "SAMPLE - NOT FINAL REPORT") -> None:
    """Create a watermark PDF with diagonal text.
    
    Args:
        watermark_path: Path where watermark PDF will be saved
        width: Page width in points
        height: Page height in points
        text: Text to display as watermark
    """
    c = pdf_canvas.Canvas(watermark_path, pagesize=(width, height))
    
    # Set semi-transparent red color
    c.setFillColorRGB(1, 0, 0, alpha=0.3)
    c.setFont('Helvetica-Bold', 50)
    
    text_width = c.stringWidth(text, 'Helvetica-Bold', 50)

    # Calculate diagonal angle
    angle = math.degrees(math.atan2(height, width))
    
    # Calculate spacing between text horizontally and vertically
    horizontal_spacing = text_width * 1.1
    vertical_spacing = 240  # Vertical spacing between rows
    row_offset = horizontal_spacing * 0.5  # Offset each row by half the horizontal spacing
    
    # Calculate how many rows and columns we need
    diagonal_length = math.sqrt(width**2 + height**2)
    num_horizontal = int(diagonal_length / horizontal_spacing) + 3
    num_vertical = int(diagonal_length / vertical_spacing) + 2
    
    c.saveState()
    c.translate(width/2, height/2)
    c.rotate(angle)
    
    # Draw text in a grid pattern to fill the page
    start_x = -(num_horizontal * horizontal_spacing) / 2
    start_y = -(num_vertical * vertical_spacing) / 2
    
    for row in range(num_vertical):
        # Alternate offset direction for each row
        offset = (row % 2) * row_offset
        for col in range(num_horizontal):
            x_pos = start_x + (col * horizontal_spacing) + offset
            y_pos = start_y + (row * vertical_spacing)
            c.drawString(x_pos, y_pos, text)
    
    c.restoreState()
    
    c.showPage()
    c.save()


def apply_watermark(pdf_path: str, watermark_text: str = "SAMPLE - NOT FINAL REPORT") -> None:
    """Apply watermark to existing PDF.
    
    Args:
        pdf_path: Path to PDF file to watermark
        watermark_text: Text to display as watermark
        
    Raises:
        ImportError: If PyPDF2 is not installed
        FileNotFoundError: If PDF file does not exist
    """
    try:
        from PyPDF2 import PdfReader, PdfWriter
    except ImportError:
        raise ImportError("PyPDF2 not installed. Install with: pip install PyPDF2")
    
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
    
    # Track unique page sizes to reuse watermarks
    watermark_cache = {}
    
    try:
        # Read the original PDF
        reader = PdfReader(pdf_path)
        writer = PdfWriter()
        
        # Merge watermark with each page
        for page in reader.pages:
            # Get page dimensions
            page_box = page.mediabox
            width = float(page_box.width)
            height = float(page_box.height)
            size_key = (width, height)
            
            # Create watermark for this size if not cached
            if size_key not in watermark_cache:
                watermark_path = os.path.join(tempfile.gettempdir(), f'watermark_{width}x{height}.pdf')
                create_watermark_pdf(watermark_path, width, height, watermark_text)
                watermark_reader = PdfReader(watermark_path)
                watermark_cache[size_key] = (watermark_path, watermark_reader.pages[0])
            
            # Apply cached watermark
            _, watermark_page = watermark_cache[size_key]
            page.merge_page(watermark_page)
            writer.add_page(page)
        
        # Write to temporary file then replace original
        temp_output = pdf_path + '.tmp'
        with open(temp_output, 'wb') as output_file:
            writer.write(output_file)
        
        # Replace original with watermarked version
        os.replace(temp_output, pdf_path)
        
    finally:
        # Clean up watermark files
        for watermark_path, _ in watermark_cache.values():
            try:
                os.remove(watermark_path)
            except:
                pass


def main():
    """Command-line interface for watermarking PDFs."""
    parser = argparse.ArgumentParser(
        description='Apply watermark to PDF file',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Apply default watermark to a PDF
  python watermark.py report.pdf
  
  # Apply custom watermark text
  python watermark.py report.pdf --text "DRAFT - CONFIDENTIAL"
        """
    )
    parser.add_argument('pdf_file', help='PDF file to watermark')
    parser.add_argument('--text', default='SAMPLE - NOT FINAL REPORT',
                       help='Watermark text (default: "SAMPLE - NOT FINAL REPORT")')
    
    args = parser.parse_args()
    
    try:
        print(f'Applying watermark to: {args.pdf_file}')
        apply_watermark(args.pdf_file, args.text)
        print(f'✓ Successfully watermarked: {args.pdf_file}')
        return 0
    except Exception as e:
        print(f'✗ Error watermarking {args.pdf_file}: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
