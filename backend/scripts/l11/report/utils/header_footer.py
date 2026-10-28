import os
import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from PIL import Image
from typing import Optional

class HeaderFooter:
    """Handles header and footer generation for PDF reports."""
    
    # Point to report/sections/resources directory
    REPORT_DIR = os.path.dirname(os.path.dirname(__file__))  # Go up to report directory
    RESOURCES_DIR = os.path.join(REPORT_DIR, "sections", "resources")
    
    def __init__(self, rack_path: str):
        self.rack_path = rack_path
        self.page_counter = 1

    def draw_header_footer(self, pdf_canvas, total_pages: Optional[int] = None) -> None:
        """Draw header and footer on a PDF page.
        
        Args:
            pdf_canvas: ReportLab canvas object
            total_pages: Optional total number of pages for page numbering
        """
        # Header: ssic.png on top left, supermicro.png on top right
        ssic_path = os.path.join(self.RESOURCES_DIR, "ssic.png")
        supermicro_path = os.path.join(self.RESOURCES_DIR, "supermicro.png")
        header_height = 0.5 * inch
        padding = 0.25 * inch
        if os.path.exists(ssic_path):
            img = Image.open(ssic_path)
            img_width, img_height = img.size
            ssic_scale = (header_height / img_height) * 0.5
            ssic_display_width = img_width * ssic_scale
            ssic_display_height = img_height * ssic_scale
            img_reader = ImageReader(ssic_path)
            # Header left
            pdf_canvas.drawImage(img_reader, padding, letter[1] - padding - ssic_display_height, width=ssic_display_width, height=ssic_display_height)
            # Footer right
            pdf_canvas.drawImage(img_reader, letter[0] - padding - ssic_display_width, padding, width=ssic_display_width, height=ssic_display_height)
        if os.path.exists(supermicro_path):
            img = Image.open(supermicro_path)
            img_width, img_height = img.size
            supermicro_scale = header_height / img_height
            supermicro_display_width = img_width * supermicro_scale
            supermicro_display_height = header_height
            img_reader = ImageReader(supermicro_path)
            pdf_canvas.drawImage(img_reader, letter[0] - padding - supermicro_display_width, letter[1] - padding - supermicro_display_height, width=supermicro_display_width, height=supermicro_display_height, mask='auto')
        # Draw footer text
        pdf_canvas.setFont('Helvetica', 8)
        pdf_canvas.setFillColor(colors.black)
        pdf_canvas.drawString(0.25*inch, 0.25*inch, "AI and HPC Team: ReeannZ@supermicro.com")
        pdf_canvas.drawString(0.25*inch, 0.15*inch, f"Generated on: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        # Draw page number
        pdf_canvas.setFont('Helvetica', 10)
        pdf_canvas.setFillColor(colors.black)
        if total_pages:
            pdf_canvas.drawCentredString(letter[0]/2, 0.25*inch, f'Page {self.page_counter} of {total_pages}')
        else:
            pdf_canvas.drawCentredString(letter[0]/2, 0.25*inch, f'Page {self.page_counter}')
        self.page_counter += 1

    def reset_counter(self) -> None:
        self.page_counter = 1